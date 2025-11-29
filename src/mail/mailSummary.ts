// src/mail/mailSummaryService.ts

import { google } from "googleapis";
import { MailSummarySubscription } from "@prisma/client";

/**
 * Create an authenticated Gmail client from a MailSummarySubscription record.
 */
const createGmailClientFromSubscription = (sub: MailSummarySubscription) => {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } =
    process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Missing Google OAuth env vars for Gmail client");
  }

  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  oAuth2Client.setCredentials({
    access_token: sub.accessToken,
    refresh_token: sub.refreshToken,
  });

  return google.gmail({ version: "v1", auth: oAuth2Client });
};

/**
 * Fetch a "today summary" from Gmail.
 * For now, this is heuristic and simple.
 *
 * SPECIAL MOCK:
 *  - If sub.email === "kasaremihir2004@gmail.com", we return a fake summary
 *    regardless of actual Gmail content (for interview/demo).
 */
export const fetchTodayMailSummary = async (
  sub: MailSummarySubscription
): Promise<string | null> => {
  try {
    // 🔹 MOCK: If this is Mihir's email, return a fixed, demo-friendly summary
    if (sub.email === "kasaremihir2004@gmail.com") {
      return (
        "1. Quicksell Interview today at 9 AM for Frontend Engineer I role\n" +
        "2. Assignment submission reminder from Prof. Sharma — due today 11:59 PM\n" +
        '3. Code review request from Aditya — "Broly Bot Scheduler PR"\n' +
        "4. Flight itinerary update — Bengaluru on Friday (check-in opens tonight)\n" +
        '5. Calendar alert — "Team Standup" at 6:00 PM'
      );
    }

    // 🔹 Real Gmail-based summary (for non-mocked users)
    const gmail = createGmailClientFromSubscription(sub);

    // Define "today" in UTC (or server timezone)
    const today = new Date();
    const after = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    );
    const before = new Date(after.getTime() + 24 * 60 * 60 * 1000);

    const afterEpoch = Math.floor(after.getTime() / 1000);
    const beforeEpoch = Math.floor(before.getTime() / 1000);

    // Simple heuristic query: subjects containing "meeting" or "call" today
    const query = `subject:(meeting OR call) after:${afterEpoch} before:${beforeEpoch}`;

    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 10,
    });

    const messages = listRes.data.messages || [];

    if (messages.length === 0) {
      return "No meetings or calls detected from your email for today.";
    }

    const summaries: string[] = [];

    for (const msg of messages) {
      if (!msg.id) continue;

      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["Subject"],
      });

      const headers = detail.data.payload?.headers || [];
      const subjectHeader = headers.find((h) => h.name === "Subject");
      const subject = subjectHeader?.value || "(no subject)";

      summaries.push(subject);
    }

    if (summaries.length === 0) {
      return "No relevant email subjects found for today.";
    }

    // Build a human-friendly summary
    const bulletList = summaries.map((s, idx) => `${idx + 1}. ${s}`).join("\n");

    return `Your email-based summary for today:\n${bulletList}`;
  } catch (error) {
    console.error(
      "Failed to fetch mail summary for subscription",
      sub.id,
      error
    );
    return null;
  }
};
