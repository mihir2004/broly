import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import twilio, { Twilio } from "twilio";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

const twilioClient: Twilio = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

export function startScheduler() {
  // Runs every minute
  cron.schedule("* * * * *", async () => {
    const now = new Date();

    try {
      const dueReminders = await prisma.reminder.findMany({
        where: {
          time: {
            lte: now,
          },
        },
      });

      for (const reminder of dueReminders) {
        try {
          await twilioClient.messages.create({
            from: process.env.TWILIO_PHONE_NUMBER!,
            to: reminder.phone,
            body: `Reminder: ${reminder.message}`,
          });

          await prisma.reminder.delete({
            where: { id: reminder.id },
          });
        } catch (err) {
          console.error("Failed to send reminder", reminder.id, err);
        }
      }
    } catch (err) {
      console.error("Error while checking reminders:", err);
    }
  });
}
