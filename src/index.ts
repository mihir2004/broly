import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import twilio, { Twilio } from "twilio";
import { PrismaClient } from "@prisma/client";
import moment from "moment";
import dotenv from "dotenv";
import { startScheduler } from "./reminders/scheduler";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const prisma = new PrismaClient();

const twilioClient: Twilio = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

type SessionStage = "awaiting_message" | "awaiting_time";

interface SessionState {
  stage: SessionStage;
  message?: string;
}

// In-memory session store: phone -> state
const sessions: Record<string, SessionState> = {};

const port = process.env.PORT || 3000;

/**
 * WhatsApp Webhook
 *
 * Flow:
 *  - "hi"/"hello" → ask what to remind
 *  - next msg → store as reminder text; ask for time
 *  - time msg → parse, store in DB, confirm
 */
app.post("/whatsapp", async (req: Request, res: Response) => {
  console.log("👉 Incoming WhatsApp webhook:", {
    body: req.body,
    time: new Date().toISOString(),
  });
  const rawBody: string | undefined = req.body.Body;
  const from: string | undefined = req.body.From;

  if (!rawBody || !from) {
    res.status(400).send("Bad Request");
    return;
  }

  const body = rawBody.trim();
  const lower = body.toLowerCase();
  let responseMessage = "";

  const session = sessions[from];

  // 1) Start flow: Hi / Hello
  if (lower === "hi" || lower === "hello") {
    sessions[from] = { stage: "awaiting_message" };
    responseMessage = "Hey! What do you want me to remind you about?";
  }
  // 2) Capture reminder message
  else if (session?.stage === "awaiting_message") {
    sessions[from] = {
      stage: "awaiting_time",
      message: body, // keep original case
    };
    responseMessage =
      'Got it \nNow tell me **when** to remind you.\nExamples: "9:36AM", "9:36 PM", or "14:56".';
  }
  // 3) Capture time, store in DB
  else if (session?.stage === "awaiting_time") {
    const reminderText = session.message!;
    let reminderTime = moment(body, ["HH:mm", "H:mm", "h:mm A", "h:mma"], true);

    if (!reminderTime.isValid()) {
      responseMessage =
        'I could not understand that time.\nPlease send something like "9:36AM" or "14:56".';
    } else {
      // Attach date (today); if time already passed, schedule for tomorrow
      const now = moment();
      reminderTime.year(now.year()).month(now.month()).date(now.date());

      if (reminderTime.isBefore(now)) {
        reminderTime.add(1, "day");
      }

      try {
        await prisma.reminder.create({
          data: {
            phone: from,
            time: reminderTime.toDate(),
            message: reminderText,
          },
        });

        responseMessage = `All set! 🧠\nI'll remind you about:\n"${reminderText}"\nat ${reminderTime.format(
          "YYYY-MM-DD HH:mm"
        )}.`;

        delete sessions[from];
      } catch (err) {
        console.error("Error saving reminder:", err);
        responseMessage =
          "Sorry, I couldn't save your reminder due to an internal error.";
      }
    }
  }
  // 4) Fallback
  else {
    responseMessage =
      'I did not quite get that \nSend "hi" to start setting a reminder.';
  }

  // Send reply via Twilio
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER!,
      to: from,
      body: responseMessage,
    });
  } catch (err) {
    console.error("Error sending Twilio message:", err);
  }

  // Twilio expects a 200 OK quickly
  res.type("text/xml").send("<Response></Response>");
});

// Health check
app.get("/", (_req: Request, res: Response) => {
  res.send("Broly Bot is running 🟢");
});

// Start scheduler + server
startScheduler();

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
