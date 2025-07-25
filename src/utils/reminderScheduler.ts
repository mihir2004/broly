// src/utils/reminderScheduler.ts
import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

export function startReminderCheck(sendMessage: Function) {
  cron.schedule("* * * * *", async () => {
    const now = new Date();
    const reminders = await prisma.reminder.findMany({
      where: {
        sent: false,
        remindAt: {
          lte: now,
        },
      },
    });

    for (const reminder of reminders) {
      await sendMessage(reminder.userId, `⏰ Reminder: ${reminder.message}`);
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: { sent: true },
      });
    }
  });
}
