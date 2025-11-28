// src/reminders/scheduler.ts
// Cron-based scheduler that periodically checks for due reminders,
// recurring reminders, and daily weather updates.

import cron from "node-cron";
import twilio, { Twilio } from "twilio";
import dotenv from "dotenv";
import { prisma } from "../prisma";
import fetch from "node-fetch";

dotenv.config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;
const weatherApiKey = process.env.WEATHER_API_KEY;

if (!accountSid || !authToken || !fromNumber) {
  console.warn(
    "Twilio credentials or phone number missing. Scheduler will still run but may fail to send messages."
  );
}

if (!weatherApiKey) {
  console.warn("WEATHER_API_KEY is not set; weather updates will be skipped.");
}

const twilioClient: Twilio = twilio(accountSid || "", authToken || "");

/**
 * Formats the current time as "HH:mm" in 24-hour format.
 */
function getCurrentTimeString(date: Date): string {
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Returns true if two dates are on the same calendar day.
 */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Returns true if two dates are in the same year and month.
 */
function isSameYearMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/**
 * Fetch a short weather summary for a given city.
 */
async function fetchWeatherSummary(city: string): Promise<string | null> {
  if (!weatherApiKey) return null;

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
      city
    )}&appid=${weatherApiKey}&units=metric`;

    const resp = await fetch(url);
    if (!resp.ok) {
      console.error("Weather API error:", resp.status, await resp.text());
      return null;
    }

    const data: any = await resp.json();
    const temp = data.main?.temp;
    const feelsLike = data.main?.feels_like;
    const desc = data.weather?.[0]?.description;
    const humidity = data.main?.humidity;

    if (temp == null || !desc) {
      return `Weather information not available for ${city}.`;
    }

    return `Weather in ${city} now: ${Math.round(
      temp
    )}°C, ${desc}. Feels like ${Math.round(feelsLike ?? temp)}°C. Humidity: ${
      humidity ?? "N/A"
    }%.`;
  } catch (err) {
    console.error("Error fetching weather:", err);
    return null;
  }
}

/**
 * Starts a cron job that runs once per minute.
 * - One-time reminders: send and delete when time <= now
 * - Recurring reminders: send at configured time
 * - Weather subscriptions: daily at 09:00
 */
export function startScheduler() {
  cron.schedule("* * * * *", async () => {
    const now = new Date();

    try {
      // One-time reminders
      const dueReminders = await prisma.reminder.findMany({
        where: {
          time: {
            lte: now,
          },
        },
        include: {
          user: true,
        },
      });

      for (const reminder of dueReminders) {
        if (!reminder.user) continue;

        try {
          if (accountSid && authToken && fromNumber) {
            await twilioClient.messages.create({
              from: fromNumber,
              to: reminder.user.whatsappNumber,
              body: `Reminder: ${reminder.message}`,
            });
          } else {
            console.warn(
              "Skipped sending reminder because Twilio config is incomplete"
            );
          }

          await prisma.reminder.delete({
            where: { id: reminder.id },
          });
        } catch (err) {
          console.error("Failed to send one-time reminder", reminder.id, err);
        }
      }

      // Recurring reminders
      const timeStr = getCurrentTimeString(now);
      const dayOfMonth = now.getDate();

      const recurring = await prisma.recurringReminder.findMany({
        where: {
          active: true,
        },
        include: {
          user: true,
        },
      });

      for (const rr of recurring) {
        if (!rr.user) continue;
        if (rr.timeOfDay !== timeStr) continue;

        const last = rr.lastTriggeredAt ? new Date(rr.lastTriggeredAt) : null;
        let shouldTrigger = false;

        if (rr.recurrenceType === "DAILY") {
          if (!last || !isSameDay(now, last)) {
            shouldTrigger = true;
          }
        } else if (rr.recurrenceType === "MONTHLY") {
          if (rr.dayOfMonth && rr.dayOfMonth === dayOfMonth) {
            if (!last || !isSameYearMonth(now, last)) {
              shouldTrigger = true;
            }
          }
        }

        if (!shouldTrigger) continue;

        try {
          if (accountSid && authToken && fromNumber) {
            await twilioClient.messages.create({
              from: fromNumber,
              to: rr.user.whatsappNumber,
              body: `Recurring reminder: ${rr.message}`,
            });
          } else {
            console.warn(
              "Skipped sending recurring reminder because Twilio config is incomplete"
            );
          }

          await prisma.recurringReminder.update({
            where: { id: rr.id },
            data: { lastTriggeredAt: now },
          });
        } catch (err) {
          console.error("Failed to send recurring reminder", rr.id, err);
        }
      }

      // Weather subscriptions: daily at 09:00
      const weatherTime = "09:00";
      if (timeStr === weatherTime && weatherApiKey) {
        const subs = await prisma.weatherSubscription.findMany({
          where: { active: true },
          include: { user: true },
        });

        for (const sub of subs) {
          if (!sub.user) continue;

          const last = sub.lastSentAt ? new Date(sub.lastSentAt) : null;
          if (last && isSameDay(now, last)) {
            continue;
          }

          try {
            const summary = await fetchWeatherSummary(sub.city);
            if (!summary) continue;

            if (accountSid && authToken && fromNumber) {
              await twilioClient.messages.create({
                from: fromNumber,
                to: sub.user.whatsappNumber,
                body: `Daily weather update: ${summary}`,
              });
            }

            await prisma.weatherSubscription.update({
              where: { id: sub.id },
              data: { lastSentAt: now },
            });
          } catch (err) {
            console.error(
              "Failed to send weather update for subscription",
              sub.id,
              err
            );
          }
        }
      }
    } catch (err) {
      console.error("Error while checking reminders:", err);
    }
  });
}
