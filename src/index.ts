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

// --- Session state (in-memory; keyed by Twilio 'From' value) ---
type SessionStage = "awaiting_message" | "awaiting_time";
interface SessionState {
  stage: SessionStage;
  message?: string;
}
const sessions: Record<string, SessionState> = {};
const weatherCitySessions: Record<string, boolean> = {};

// --- Help / Welcome messages ---
const HELP_MESSAGE = `I am Broly, your WhatsApp reminder buddy.

Commands / usage:
• "hi" - start guided step-by-step reminder setup (works for all users)
• Natural: "remind me to call mom at 5pm"
• "list" - show active reminders/subscriptions
• "cancel <id>" or "cancel recurring <id>"
• "subscribe weather <city>" or "subscribe weather"
• "cancel weather" / "unsubscribe weather"

Snooze:
• "snooze 10 minutes" or "snooze 1 hour"
`.trim();

function buildWelcomeMessage(name?: string | null): string {
  const who = name ? ` ${name}` : "";
  return (
    `Hey${who}! I am Broly, your reminder assistant.\n` +
    `I can help you create quick reminders or guide you step-by-step.\n\n` +
    `Try natural language: "remind me to submit assignment at 11pm today"\n` +
    `Or send "hi" to create a reminder interactively.\n` +
    `Type "help" anytime to see all features.`
  );
}

// --- Utility: send WhatsApp message via Twilio (single place to change) ---
const sendWhatsAppMessage = async (to: string, body: string) => {
  if (!accountSid || !authToken || !fromNumber) {
    console.warn("Skipping Twilio send - credentials missing.");
    return;
  }
  try {
    await twilioClient.messages.create({
      from: fromNumber,
      to,
      body,
    });
  } catch (err) {
    console.error("Error sending Twilio message:", err);
  }
};

// --- Simple relative "in X minutes/hours" parser (fallback) ---
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

// --- Snooze helpers ---
type SnoozeUnit = "minute" | "hour";
interface SnoozeParseResult {
  offsetMs: number;
  amount: number;
  unit: SnoozeUnit;
}

const SNOOZE_UNIT_MAP: Record<string, SnoozeUnit> = {
  min: "minute",
  mins: "minute",
  minute: "minute",
  minutes: "minute",
  m: "minute",

  h: "hour",
  hr: "hour",
  hrs: "hour",
  hour: "hour",
  hours: "hour",
};

const parseSnoozeArgs = (tokens: string[]): SnoozeParseResult | null => {
  if (tokens.length < 2) return null;
  const [rawAmount, ...rawUnitTokens] = tokens;
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unitKey = rawUnitTokens.join(" ").toLowerCase();
  const normalizedUnit = SNOOZE_UNIT_MAP[unitKey];
  if (!normalizedUnit) return null;

  const minutes = normalizedUnit === "minute" ? amount : amount * 60;
  const offsetMs = minutes * 60 * 1000;
  return { offsetMs, amount, unit: normalizedUnit };
};

interface SnoozeUserContext {
  id: string;
  whatsappNumber: string;
  lastReminderMessage: string | null;
  lastReminderTime: Date | null;
}

interface HandleSnoozeArgs {
  user: SnoozeUserContext;
  restTokens: string[];
  from: string;
}

const handleSnoozeCommand = async ({
  user,
  restTokens,
  from,
}: HandleSnoozeArgs): Promise<void> => {
  if (restTokens.length === 0) {
    await sendWhatsAppMessage(
      from,
      'Please specify how long to snooze. Example: "snooze 10 minutes" or "snooze 1 hour".'
    );
    return;
  }

  const parsed = parseSnoozeArgs(restTokens);
  if (!parsed) {
    await sendWhatsAppMessage(
      from,
      'I could not understand that snooze duration. Try "snooze 10 minutes" or "snooze 2 hours".'
    );
    return;
  }

  const { offsetMs, amount, unit } = parsed;

  if (!user.lastReminderMessage || !user.lastReminderTime) {
    await sendWhatsAppMessage(
      from,
      "I don't have a recent reminder to snooze. Create a reminder first, then try snoozing."
    );
    return;
  }

  const now = new Date();
  // FIXED: use + offset to schedule in the future
  const snoozedTime = new Date(now.getTime() + offsetMs);

  try {
    await prisma.reminder.create({
      data: {
        userId: user.id,
        time: snoozedTime,
        message: user.lastReminderMessage!,
      },
    });

    const unitLabel = unit === "minute" ? "minute" : "hour";
    const amountWithUnit =
      amount === 1 ? `${amount} ${unitLabel}` : `${amount} ${unitLabel}s`;

    await sendWhatsAppMessage(
      from,
      `Got it! I'll remind you again in ${amountWithUnit} about: "${user.lastReminderMessage}".`
    );
  } catch (error) {
    console.error("Error creating snoozed reminder:", error);
    await sendWhatsAppMessage(
      from,
      "Something went wrong while setting your snooze. Please try again in a moment."
    );
  }
};

// --- Routes ---

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

  // Resolve user (keeps your existing helper usage)
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

  // Basic flags / matches
  const isGreeting = ["hi", "hello", "hey"].includes(lower);
  const isHelp = ["help", "menu"].includes(lower);
  const isList = lower === "list" || lower === "list reminders";
  const looksLikeReminderSentence =
    lower.includes("remind") || lower.includes("reminder");
  const cancelRecurringMatch = lower.match(/^cancel\s+recurring\s+(\d+)\b/);
  const cancelOneTimeMatch = lower.match(/^cancel\s+(\d+)\b/);
  const subscribeWeatherWithCityMatch = text.match(
    /^\s*subscribe\s+weather\s+(.+)$/i
  );
  const isSubscribeWeatherBare = /^\s*subscribe\s+weather\s*$/i.test(text);
  const cancelWeather =
    lower === "cancel weather" || lower === "unsubscribe weather";

  // Tokens for command-first handlers (snooze, etc.)
  const tokens = lower.split(/\s+/);
  const [command, ...restTokens] = tokens;

  // 0) If awaiting weather city prompt
  if (weatherCitySessions[from]) {
    const city = text.trim();
    delete weatherCitySessions[from];

    if (!city) {
      await sendWhatsAppMessage(
        from,
        'I did not catch a city name. Please send something like "Mumbai" or "Bangalore".'
      );
      res.type("text/xml").send("<Response></Response>");
      return;
    }
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
      await sendWhatsAppMessage(
        from,
        `Subscribed to daily weather updates at 9am for ${city}.`
      );
    } catch (err) {
      console.error("Error subscribing to weather after city prompt:", err);
      await sendWhatsAppMessage(
        from,
        "There was an error setting up your weather subscription."
      );
    }
    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // SNOOZE command branch (handle early)
  if (command === "snooze") {
    await handleSnoozeCommand({
      user: {
        id: user.id,
        whatsappNumber: user.whatsappNumber,
        lastReminderMessage: user.lastReminderMessage,
        lastReminderTime: user.lastReminderTime,
      },
      restTokens,
      from,
    });
    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // Weather subscribe with city
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
      await sendWhatsAppMessage(
        from,
        `Subscribed to daily weather updates at 9am for ${city}.`
      );
    } catch (err) {
      console.error("Error subscribing to weather:", err);
      await sendWhatsAppMessage(
        from,
        "There was an error setting up your weather subscription."
      );
    }
    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // Weather subscribe bare
  if (isSubscribeWeatherBare) {
    try {
      const existing = await prisma.weatherSubscription.findUnique({
        where: { userId: user.id },
      });
      if (existing && existing.city && existing.active) {
        await sendWhatsAppMessage(
          from,
          `You are already subscribed to daily weather updates for ${existing.city} at 9am.`
        );
      } else if (existing && existing.city) {
        await prisma.weatherSubscription.update({
          where: { userId: user.id },
          data: { active: true },
        });
        await sendWhatsAppMessage(
          from,
          `Your daily weather updates for ${existing.city} have been (re)activated.`
        );
      } else {
        weatherCitySessions[from] = true;
        await sendWhatsAppMessage(
          from,
          'Which city should I use for your daily weather updates? Send the city name, for example: "Mumbai".'
        );
      }
    } catch (err) {
      console.error("Error handling bare weather subscribe:", err);
      await sendWhatsAppMessage(
        from,
        "There was an error handling your weather subscription request."
      );
    }
    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // Weather cancel
  if (cancelWeather) {
    try {
      const existing = await prisma.weatherSubscription.findUnique({
        where: { userId: user.id },
      });

      if (!existing || !existing.active) {
        await sendWhatsAppMessage(
          from,
          "You do not have an active weather subscription to cancel."
        );
      } else {
        await prisma.weatherSubscription.update({
          where: { userId: user.id },
          data: { active: false },
        });
        await sendWhatsAppMessage(
          from,
          `Your daily weather updates for ${existing.city} have been canceled.`
        );
      }
    } catch (err) {
      console.error("Error canceling weather subscription:", err);
      await sendWhatsAppMessage(
        from,
        "There was an error canceling your weather subscription."
      );
    }
    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // Cancel recurring reminders
  if (cancelRecurringMatch) {
    const id = parseInt(cancelRecurringMatch[1], 10);
    if (!isNaN(id)) {
      try {
        const rr = await prisma.recurringReminder.findFirst({
          where: { id, userId: user.id, active: true },
        });
        if (!rr) {
          await sendWhatsAppMessage(
            from,
            `I could not find an active recurring reminder with id ${id} for you.`
          );
        } else {
          await prisma.recurringReminder.update({
            where: { id: rr.id },
            data: { active: false },
          });
          await sendWhatsAppMessage(
            from,
            `Recurring reminder ${id} canceled: "${rr.message}".`
          );
        }
      } catch (err) {
        console.error("Error canceling recurring reminder:", err);
        await sendWhatsAppMessage(
          from,
          "There was an error canceling that recurring reminder."
        );
      }
    } else {
      await sendWhatsAppMessage(
        from,
        "I could not understand which recurring reminder id to cancel."
      );
    }
    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // Cancel one-time reminders
  if (cancelOneTimeMatch) {
    const id = parseInt(cancelOneTimeMatch[1], 10);
    if (!isNaN(id)) {
      try {
        const r = await prisma.reminder.findFirst({
          where: { id, userId: user.id },
        });
        if (!r) {
          await sendWhatsAppMessage(
            from,
            `I could not find a one-time reminder with id ${id} for you.`
          );
        } else {
          await prisma.reminder.delete({
            where: { id: r.id },
          });
          await sendWhatsAppMessage(
            from,
            `One-time reminder ${id} canceled: "${r.message}".`
          );
        }
      } catch (err) {
        console.error("Error canceling one-time reminder:", err);
        await sendWhatsAppMessage(
          from,
          "There was an error canceling that reminder."
        );
      }
    } else {
      await sendWhatsAppMessage(
        from,
        "I could not understand which reminder id to cancel."
      );
    }
    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // Help
  if (isHelp) {
    await sendWhatsAppMessage(from, HELP_MESSAGE);
    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // List
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
        await sendWhatsAppMessage(
          from,
          "You do not have any active reminders or weather subscriptions right now."
        );
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
        await sendWhatsAppMessage(from, lines.join("\n"));
      }
    } catch (err) {
      console.error("Error listing reminders:", err);
      await sendWhatsAppMessage(
        from,
        "There was an error listing your reminders."
      );
    }
    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // --- NLP first attempt (if lookslike reminder and not explicitly asking for help) ---
  const shouldTryNLPFirst =
    !isHelp && (!session || isExperienced) && looksLikeReminderSentence;

  if (shouldTryNLPFirst) {
    try {
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

          await sendWhatsAppMessage(from, responseMessage);
          res.type("text/xml").send("<Response></Response>");
          return;
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

          await sendWhatsAppMessage(from, responseMessage);
          res.type("text/xml").send("<Response></Response>");
          return;
        }
      } else {
        console.log("Gemini could not confidently parse reminder:", parsed);

        // fallback to simple relative parse (e.g., "in 5 minutes")
        const relative = parseSimpleRelativeReminder(text);
        if (relative) {
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

          await sendWhatsAppMessage(from, responseMessage);
          res.type("text/xml").send("<Response></Response>");
          return;
        }
      }
    } catch (err) {
      console.error("Error during NLP parsing flow:", err);
      // fall through to session / fallback below
    }
  }

  // --- Step-by-step flow (greeting should start this for ANY user) ---
  // 1) If the user greets, start the interactive flow (works for any user)
  if (isGreeting) {
    sessions[from] = { stage: "awaiting_message" };
    responseMessage = buildWelcomeMessage(user.profileName);
    await sendWhatsAppMessage(from, responseMessage);
    res.type("text/xml").send("<Response></Response>");
    return;
  }

  // 2) If user is currently in a session, handle it (regardless of isExperienced)
  if (session) {
    if (session.stage === "awaiting_message") {
      sessions[from] = {
        stage: "awaiting_time",
        message: text,
      };
      responseMessage =
        'Noted. Now tell me what time today you want this reminder.\nExamples: "9:36AM", "9:36 PM", or "14:56".';
      await sendWhatsAppMessage(from, responseMessage);
      res.type("text/xml").send("<Response></Response>");
      return;
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
        await sendWhatsAppMessage(from, responseMessage);
        res.type("text/xml").send("<Response></Response>");
        return;
      }

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
      await sendWhatsAppMessage(from, responseMessage);
      res.type("text/xml").send("<Response></Response>");
      return;
    }
  }

  // --- Fallback for experienced users (no session) / generic fallback ---
  if (!session && isExperienced && !responseMessage) {
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

  // final generic fallback (covers new users who didn't say "hi" but didn't match anything else)
  if (!responseMessage) {
    responseMessage =
      "I did not quite understand that.\nYou can:\n" +
      '- Say "hi" to start a step-by-step reminder for today\n' +
      '- Or say something like "remind me to drink water at 5pm tomorrow"\n' +
      '- Or type "help" to see what I can do.';
  }

  await sendWhatsAppMessage(from, responseMessage);
  res.type("text/xml").send("<Response></Response>");
});

// Start scheduler and server
startScheduler();

app.listen(port, () => {
  console.log(`Broly bot backend started on port ${port}`);
});
