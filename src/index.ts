// src/index.ts

import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import twilio, { Twilio } from "twilio";
import dotenv from "dotenv";
import moment from "moment";
import { prisma } from "./prisma";
import { getOrCreateUserFromTwilio } from "./services/userService";
import { startScheduler } from "./reminders/scheduler";
import { parseReminderWithGemini } from "./nlp/geminiReminderParser";

dotenv.config();

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const port = process.env.PORT || 3000;

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;

if (!accountSid || !authToken || !fromNumber) {
  console.warn(
    "Twilio credentials or TWILIO_PHONE_NUMBER missing. Incoming messages may not get responses."
  );
}

const twilioClient: Twilio = twilio(accountSid || "", authToken || "");

// Conversation session state for step-by-step reminders
type SessionStage = "awaiting_message" | "awaiting_time";

interface SessionState {
  stage: SessionStage;
  message?: string;
}

const sessions: Record<string, SessionState> = {};

// Weather city prompt sessions: user -> expecting city name
const weatherCitySessions: Record<string, boolean> = {};

// Help message includes weather
const HELP_MESSAGE = `
I am Broly, your WhatsApp reminder buddy.

Here is what I can do right now:

1) Quick one-time reminders with natural language:
   - "remind me to drink water at 5pm"
   - "remind me to call mom tomorrow at 9 am"
   - "remind me about app running on 5th Jan at 7 pm"

2) Recurring reminders (subscriptions):
   - "remind me to pay rent on 5th of every month at 9 am"
   - "remind me to go for a walk every day at 7 pm"

3) Daily weather updates at 9am:
   - "subscribe weather Mumbai"
   - "subscribe weather Bangalore"
   - "subscribe weather" (reuse your last city or I will ask you)
   - To stop: "cancel weather" or "unsubscribe weather"

4) Step-by-step reminders (time-based, today by default):
   - Send "hi"
   - I will ask: what should I remind you about?
   - Then I will ask: at what time? (for example "9:30 PM" or "21:30")
   - I will set it for today, or tomorrow if that time has already passed.

5) Commands:
   - "hi" / "hello" / "hey" – start step-by-step reminder setup
   - "help" – show this help message
   - "list" – see your active one-time reminders, recurring reminders, and weather subscription
   - "cancel <id>" – cancel a one-time reminder by its id
   - "cancel recurring <id>" – cancel a recurring reminder by its id
   - "cancel weather" / "unsubscribe weather" – stop daily weather updates
`.trim();

function buildWelcomeMessage(name?: string | null): string {
  const who = name ? ` ${name}` : "";
  return (
    `Hey${who}! I am Broly, your reminder assistant.\n` +
    `You can talk to me in two ways:\n\n` +
    `1) Natural: "remind me to submit assignment at 11pm today"\n` +
    `2) Step-by-step: Send "hi" and I will guide you.\n\n` +
    `You can also create recurring reminders like "remind me to pay rent on 5th of every month at 9 am".\n` +
    `And you can subscribe to daily weather at 9am with "subscribe weather <city>".\n` +
    `Type "help" anytime to see all features.`
  );
}

/**
 * Simple backup parser for "in X minutes/hours".
 */
function parseSimpleRelativeReminder(
  text: string
): { reminderMessage: string; datetime: Date } | null {
  const lower = text.toLowerCase();

  const match = lower.match(
    /in\s+(\d+)\s*(min|mins|minute|minutes|hour|hours)\b/
  );
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  if (isNaN(amount) || amount <= 0) return null;

  let offsetMs = 0;
  const unit = match[2];
  if (unit.startsWith("min")) {
    offsetMs = amount * 60 * 1000;
  } else {
    offsetMs = amount * 60 * 60 * 1000;
  }

  const now = new Date();
  const datetime = new Date(now.getTime() + offsetMs);

  let cleaned = text;
  cleaned = cleaned.replace(match[0], "");
  cleaned = cleaned.replace(/\btoday\b/i, "");
  cleaned = cleaned.replace(/^remind me to\s*/i, "");
  cleaned = cleaned.replace(/^remind me\s*/i, "");
  cleaned = cleaned.trim();
  if (!cleaned) cleaned = text.trim();

  return {
    reminderMessage: cleaned,
    datetime,
  };
}

// Health check
app.get("/", (_req, res) => {
  res.send("Broly Bot is running");
});

app.post("/whatsapp", async (req: Request, res: Response) => {
  console.log("Incoming WhatsApp webhook:", {
    body: req.body,
    time: new Date().toISOString(),
  });

  const body = req.body;
  const from: string | undefined = body.From;
  const rawBody: string | undefined = body.Body;

  if (!from || !rawBody) {
    res.status(400).send("Bad Request");
    return;
  }

  const text = rawBody.trim();
  const lower = text.toLowerCase();

  // Resolve user
  let user;
  try {
    user = await getOrCreateUserFromTwilio(body);
  } catch (err) {
    console.error("Failed to get or create user:", err);
    res.status(500).send("User error");
    return;
  }

  const isExperienced = user.reminderCount > 0;

  let responseMessage = "";
  const session = sessions[from];

  const isGreeting = ["hi", "hello", "hey"].includes(lower);
  const isHelp = ["help", "menu"].includes(lower);
  const isList = lower === "list" || lower === "list reminders";
  const looksLikeReminderSentence =
    lower.includes("remind") || lower.includes("reminder");

  // Cancel patterns
  const cancelRecurringMatch = lower.match(/^cancel\s+recurring\s+(\d+)\b/);
  const cancelOneTimeMatch = lower.match(/^cancel\s+(\d+)\b/);

  // Weather commands
  const subscribeWeatherWithCityMatch = text.match(
    /^\s*subscribe\s+weather\s+(.+)$/i
  );
  const isSubscribeWeatherBare = /^\s*subscribe\s+weather\s*$/i.test(text);
  const cancelWeather =
    lower === "cancel weather" || lower === "unsubscribe weather";

  // 0) If user is in "waiting for weather city" mode, treat this message as city
  if (weatherCitySessions[from]) {
    const city = text.trim();
    delete weatherCitySessions[from];

    if (!city) {
      responseMessage =
        'I did not catch a city name. Please send something like "Mumbai" or "Bangalore".';
    } else {
      try {
        const existing = await prisma.weatherSubscription.findUnique({
          where: { userId: user.id },
        });

        if (existing) {
          await prisma.weatherSubscription.update({
            where: { userId: user.id },
            data: { city, active: true },
          });
        } else {
          await prisma.weatherSubscription.create({
            data: {
              userId: user.id,
              city,
            },
          });
        }

        responseMessage = `Subscribed to daily weather updates at 9am for ${city}.`;
      } catch (err) {
        console.error("Error subscribing to weather after city prompt:", err);
        responseMessage =
          "There was an error setting up your weather subscription.";
      }
    }

    if (accountSid && authToken && fromNumber) {
      try {
        await twilioClient.messages.create({
          from: fromNumber,
          to: from,
          body: responseMessage,
        });
      } catch (err) {
        console.error("Error sending Twilio weather city reply:", err);
      }
    }

    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // 1) Weather subscribe with city: "subscribe weather Mumbai"
  if (subscribeWeatherWithCityMatch) {
    const city = subscribeWeatherWithCityMatch[1].trim();

    try {
      const existing = await prisma.weatherSubscription.findUnique({
        where: { userId: user.id },
      });

      if (existing) {
        await prisma.weatherSubscription.update({
          where: { userId: user.id },
          data: { city, active: true },
        });
      } else {
        await prisma.weatherSubscription.create({
          data: {
            userId: user.id,
            city,
          },
        });
      }

      responseMessage = `Subscribed to daily weather updates at 9am for ${city}.`;
    } catch (err) {
      console.error("Error subscribing to weather:", err);
      responseMessage =
        "There was an error setting up your weather subscription.";
    }

    if (accountSid && authToken && fromNumber) {
      try {
        await twilioClient.messages.create({
          from: fromNumber,
          to: from,
          body: responseMessage,
        });
      } catch (err) {
        console.error("Error sending Twilio weather subscribe message:", err);
      }
    }

    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // 1b) Weather subscribe bare: "subscribe weather"
  if (isSubscribeWeatherBare) {
    try {
      const existing = await prisma.weatherSubscription.findUnique({
        where: { userId: user.id },
      });

      if (existing && existing.city && existing.active) {
        responseMessage = `You are already subscribed to daily weather updates for ${existing.city} at 9am.`;
      } else if (existing && existing.city && !existing.active) {
        await prisma.weatherSubscription.update({
          where: { userId: user.id },
          data: { active: true },
        });
        responseMessage = `Your daily weather updates for ${existing.city} have been reactivated.`;
      } else if (existing && existing.city && existing.active === false) {
        await prisma.weatherSubscription.update({
          where: { userId: user.id },
          data: { active: true },
        });
        responseMessage = `Your daily weather updates for ${existing.city} have been reactivated.`;
      } else if (existing && existing.city) {
        await prisma.weatherSubscription.update({
          where: { userId: user.id },
          data: { active: true },
        });
        responseMessage = `Your daily weather updates for ${existing.city} have been reactivated.`;
      } else {
        // No city stored yet, ask user for city
        weatherCitySessions[from] = true;
        responseMessage =
          'Which city should I use for your daily weather updates? Send the city name, for example: "Mumbai".';
      }
    } catch (err) {
      console.error("Error handling bare weather subscribe:", err);
      responseMessage =
        "There was an error handling your weather subscription request.";
    }

    if (accountSid && authToken && fromNumber) {
      try {
        await twilioClient.messages.create({
          from: fromNumber,
          to: from,
          body: responseMessage,
        });
      } catch (err) {
        console.error(
          "Error sending Twilio weather bare subscribe message:",
          err
        );
      }
    }

    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // 2) Weather cancel
  if (cancelWeather) {
    try {
      const existing = await prisma.weatherSubscription.findUnique({
        where: { userId: user.id },
      });

      if (!existing || !existing.active) {
        responseMessage =
          "You do not have an active weather subscription to cancel.";
      } else {
        await prisma.weatherSubscription.update({
          where: { userId: user.id },
          data: { active: false },
        });
        responseMessage = `Your daily weather updates for ${existing.city} have been canceled.`;
      }
    } catch (err) {
      console.error("Error canceling weather subscription:", err);
      responseMessage =
        "There was an error canceling your weather subscription.";
    }

    if (accountSid && authToken && fromNumber) {
      try {
        await twilioClient.messages.create({
          from: fromNumber,
          to: from,
          body: responseMessage,
        });
      } catch (err) {
        console.error("Error sending Twilio weather cancel message:", err);
      }
    }

    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // 3) Cancel recurring reminders
  if (cancelRecurringMatch) {
    const id = parseInt(cancelRecurringMatch[1], 10);
    if (!isNaN(id)) {
      try {
        const rr = await prisma.recurringReminder.findFirst({
          where: { id, userId: user.id, active: true },
        });
        if (!rr) {
          responseMessage = `I could not find an active recurring reminder with id ${id} for you.`;
        } else {
          await prisma.recurringReminder.update({
            where: { id: rr.id },
            data: { active: false },
          });
          responseMessage = `Recurring reminder ${id} canceled: "${rr.message}".`;
        }
      } catch (err) {
        console.error("Error canceling recurring reminder:", err);
        responseMessage =
          "There was an error canceling that recurring reminder.";
      }
    } else {
      responseMessage =
        "I could not understand which recurring reminder id to cancel.";
    }

    if (accountSid && authToken && fromNumber) {
      try {
        await twilioClient.messages.create({
          from: fromNumber,
          to: from,
          body: responseMessage,
        });
      } catch (err) {
        console.error("Error sending Twilio cancel recurring message:", err);
      }
    }

    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // 4) Cancel one-time reminders
  if (cancelOneTimeMatch) {
    const id = parseInt(cancelOneTimeMatch[1], 10);
    if (!isNaN(id)) {
      try {
        const r = await prisma.reminder.findFirst({
          where: { id, userId: user.id },
        });
        if (!r) {
          responseMessage = `I could not find a one-time reminder with id ${id} for you.`;
        } else {
          await prisma.reminder.delete({
            where: { id: r.id },
          });
          responseMessage = `One-time reminder ${id} canceled: "${r.message}".`;
        }
      } catch (err) {
        console.error("Error canceling one-time reminder:", err);
        responseMessage = "There was an error canceling that reminder.";
      }
    } else {
      responseMessage = "I could not understand which reminder id to cancel.";
    }

    if (accountSid && authToken && fromNumber) {
      try {
        await twilioClient.messages.create({
          from: fromNumber,
          to: from,
          body: responseMessage,
        });
      } catch (err) {
        console.error("Error sending Twilio cancel message:", err);
      }
    }

    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // 5) Help
  if (isHelp) {
    responseMessage = HELP_MESSAGE;

    if (accountSid && authToken && fromNumber) {
      try {
        await twilioClient.messages.create({
          from: fromNumber,
          to: from,
          body: responseMessage,
        });
      } catch (err) {
        console.error("Error sending Twilio help message:", err);
      }
    }

    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // 6) List (includes weather)
  if (isList) {
    try {
      const now = new Date();
      const oneTime = await prisma.reminder.findMany({
        where: {
          userId: user.id,
          time: {
            gt: now,
          },
        },
        orderBy: { time: "asc" },
      });

      const recurring = await prisma.recurringReminder.findMany({
        where: {
          userId: user.id,
          active: true,
        },
        orderBy: { id: "asc" },
      });

      const weatherSub = await prisma.weatherSubscription.findUnique({
        where: { userId: user.id },
      });

      if (
        oneTime.length === 0 &&
        recurring.length === 0 &&
        !weatherSub?.active
      ) {
        responseMessage =
          "You do not have any active reminders or weather subscriptions right now.";
      } else {
        const lines: string[] = [
          "Here are your active reminders and subscriptions:",
        ];

        if (oneTime.length > 0) {
          lines.push("", "One-time reminders:");
          for (const r of oneTime) {
            lines.push(
              `- [${r.id}] "${r.message}" at ${moment(r.time).format(
                "YYYY-MM-DD HH:mm"
              )}`
            );
          }
        }

        if (recurring.length > 0) {
          lines.push("", "Recurring reminders:");
          for (const rr of recurring) {
            if (rr.recurrenceType === "DAILY") {
              lines.push(
                `- [${rr.id}] DAILY at ${rr.timeOfDay}: "${rr.message}"`
              );
            } else if (rr.recurrenceType === "MONTHLY") {
              lines.push(
                `- [${rr.id}] MONTHLY on day ${rr.dayOfMonth} at ${rr.timeOfDay}: "${rr.message}"`
              );
            }
          }
        }

        if (weatherSub && weatherSub.active) {
          lines.push(
            "",
            `Weather subscription: daily at 09:00 for city "${weatherSub.city}".`
          );
        }

        lines.push(
          "",
          'To cancel, send "cancel <id>", "cancel recurring <id>", or "cancel weather".'
        );

        responseMessage = lines.join("\n");
      }
    } catch (err) {
      console.error("Error listing reminders:", err);
      responseMessage = "There was an error listing your reminders.";
    }

    if (accountSid && authToken && fromNumber) {
      try {
        await twilioClient.messages.create({
          from: fromNumber,
          to: from,
          body: responseMessage,
        });
      } catch (err) {
        console.error("Error sending Twilio list message:", err);
      }
    }

    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // 7) NLP for reminders (unchanged except string recurrence types)
  const isGreetingWord = isGreeting;
  const shouldTryNLPFirst =
    !isHelp && (!session || isExperienced) && looksLikeReminderSentence;

  if (shouldTryNLPFirst) {
    const parsed = await parseReminderWithGemini(text, {
      timezone: "Asia/Kolkata",
    });

    if (
      parsed &&
      parsed.intent === "create_reminder" &&
      parsed.datetimeISO &&
      parsed.reminderMessage &&
      parsed.confidence >= 0.6
    ) {
      try {
        const dt = new Date(parsed.datetimeISO);

        const recursMonthly =
          lower.includes("every month") ||
          lower.includes("each month") ||
          lower.includes("monthly");

        const recursDaily =
          lower.includes("every day") ||
          lower.includes("everyday") ||
          lower.includes("daily");

        if (recursMonthly || recursDaily) {
          const hour = dt.getHours().toString().padStart(2, "0");
          const minute = dt.getMinutes().toString().padStart(2, "0");
          const timeOfDay = `${hour}:${minute}`;

          const recurrenceType: "DAILY" | "MONTHLY" = recursMonthly
            ? "MONTHLY"
            : "DAILY";

          const dayOfMonth = recursMonthly ? dt.getDate() : null;

          await prisma.$transaction([
            prisma.recurringReminder.create({
              data: {
                userId: user.id,
                message: parsed.reminderMessage,
                recurrenceType,
                dayOfMonth: dayOfMonth ?? undefined,
                timeOfDay,
              },
            }),
            prisma.user.update({
              where: { id: user.id },
              data: {
                reminderCount: { increment: 1 },
              },
            }),
          ]);

          if (recurrenceType === "MONTHLY") {
            responseMessage = `Got it${
              user.profileName ? ", " + user.profileName : ""
            }. I will remind you every month on day ${dayOfMonth} at ${timeOfDay} to "${
              parsed.reminderMessage
            }".`;
          } else {
            responseMessage = `Got it${
              user.profileName ? ", " + user.profileName : ""
            }. I will remind you every day at ${timeOfDay} to "${
              parsed.reminderMessage
            }".`;
          }
        } else {
          await prisma.$transaction([
            prisma.reminder.create({
              data: {
                userId: user.id,
                time: dt,
                message: parsed.reminderMessage,
              },
            }),
            prisma.user.update({
              where: { id: user.id },
              data: {
                reminderCount: { increment: 1 },
              },
            }),
          ]);

          responseMessage = `Got it${
            user.profileName ? ", " + user.profileName : ""
          }. I will remind you: "${parsed.reminderMessage}" at ${moment(
            dt
          ).format("YYYY-MM-DD HH:mm")}.`;
        }

        if (accountSid && authToken && fromNumber) {
          try {
            await twilioClient.messages.create({
              from: fromNumber,
              to: from,
              body: responseMessage,
            });
          } catch (err) {
            console.error("Error sending Twilio message:", err);
          }
        }

        res.type("text/xml").send("<Response></Response>");
        return;
      } catch (err) {
        console.error("Error saving Gemini-parsed reminder:", err);
        // fall through
      }
    } else {
      console.log("Gemini could not confidently parse reminder:", parsed);

      const relative = parseSimpleRelativeReminder(text);
      if (relative) {
        try {
          await prisma.$transaction([
            prisma.reminder.create({
              data: {
                userId: user.id,
                time: relative.datetime,
                message: relative.reminderMessage,
              },
            }),
            prisma.user.update({
              where: { id: user.id },
              data: {
                reminderCount: { increment: 1 },
              },
            }),
          ]);

          responseMessage = `Got it${
            user.profileName ? ", " + user.profileName : ""
          }. I will remind you: "${relative.reminderMessage}" at ${moment(
            relative.datetime
          ).format("YYYY-MM-DD HH:mm")}.`;

          if (accountSid && authToken && fromNumber) {
            try {
              await twilioClient.messages.create({
                from: fromNumber,
                to: from,
                body: responseMessage,
              });
            } catch (err) {
              console.error("Error sending Twilio message:", err);
            }
          }

          res.type("text/xml").send("<Response></Response>");
          return;
        } catch (err) {
          console.error("Error saving relative parsed reminder:", err);
        }
      }
    }
  }

  // 8) Step-by-step flow for new users
  if (!isExperienced) {
    if (isGreeting || !session) {
      sessions[from] = { stage: "awaiting_message" };
      responseMessage = buildWelcomeMessage(user.profileName);
    } else if (session.stage === "awaiting_message") {
      sessions[from] = {
        stage: "awaiting_time",
        message: text,
      };
      responseMessage =
        'Noted. Now tell me what time today you want this reminder.\nExamples: "9:36AM", "9:36 PM", or "14:56".';
    } else if (session.stage === "awaiting_time") {
      const reminderText = session.message!;
      let reminderTime = moment(
        text,
        ["HH:mm", "H:mm", "h:mm A", "h:mma"],
        true
      );

      if (!reminderTime.isValid()) {
        responseMessage =
          'I could not understand that time. Please send something like "9:36AM" or "14:56" (today only).';
      } else {
        const now = moment();
        reminderTime.year(now.year()).month(now.month()).date(now.date());
        if (reminderTime.isBefore(now)) {
          reminderTime.add(1, "day");
        }

        try {
          await prisma.$transaction([
            prisma.reminder.create({
              data: {
                userId: user.id,
                time: reminderTime.toDate(),
                message: reminderText,
              },
            }),
            prisma.user.update({
              where: { id: user.id },
              data: {
                reminderCount: { increment: 1 },
              },
            }),
          ]);

          responseMessage = `All set${
            user.profileName ? ", " + user.profileName : ""
          }. I will remind you: "${reminderText}" at ${reminderTime.format(
            "YYYY-MM-DD HH:mm"
          )}.`;
        } catch (err) {
          console.error("Error saving reminder:", err);
          responseMessage =
            "I understood your reminder, but could not save it due to a database error.";
        }

        delete sessions[from];
      }
    }
  } else {
    if (!responseMessage) {
      responseMessage =
        `I could not figure out a reminder from that, ${
          user.profileName || "friend"
        }.\n` +
        `Try something like:\n` +
        `• "remind me to submit assignment at 11pm today"\n` +
        `• "remind me to call mom tomorrow at 9am"\n` +
        `• "remind me to pay rent on 5th of every month at 9 am"\n` +
        `• "subscribe weather Mumbai"\n` +
        `Or type "help" to see all options.`;
    }
  }

  if (!responseMessage) {
    responseMessage =
      "I did not quite understand that.\nYou can:\n" +
      '- Say "hi" to start a step-by-step reminder for today\n' +
      '- Or say something like "remind me to drink water at 5pm tomorrow"\n' +
      '- Or type "help" to see what I can do.';
  }

  if (accountSid && authToken && fromNumber) {
    try {
      await twilioClient.messages.create({
        from: fromNumber,
        to: from,
        body: responseMessage,
      });
    } catch (err) {
      console.error("Error sending Twilio message:", err);
    }
  }

  res.type("text/xml").send("<Response></Response>");
});

startScheduler();

app.listen(port, () => {
  console.log(`Broly bot backend started on port ${port}`);
});
