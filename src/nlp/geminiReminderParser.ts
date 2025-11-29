// Gemini-based NLP parser for natural language reminder messages.
// It extracts intent, a clean reminder message, and a future datetime.

import { GoogleGenerativeAI } from "@google/generative-ai";

export interface ParsedReminder {
  intent: "create_reminder" | "other";
  reminderMessage: string | null;
  datetimeISO: string | null; // ISO 8601 string, future datetime
  confidence: number; // 0 to 1
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not set in environment variables");
}

// Use gemini-pro which is supported with the v1beta SDK
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

export async function parseReminderWithGemini(
  text: string,
  options?: { timezone?: string; nowISO?: string }
): Promise<ParsedReminder | null> {
  const timezone = options?.timezone ?? "Asia/Kolkata";
  const nowISO = options?.nowISO ?? new Date().toISOString();

  const prompt = `
You are a reminder-parsing assistant for a WhatsApp bot.

User message:
"${text}"

Current datetime (ISO): ${nowISO}
User timezone: ${timezone}

Your task:
- Decide if the user is asking to CREATE A REMINDER.
- If yes, extract:
  - reminderMessage: a short description of what to remind,
    EXCLUDING phrases like "remind me", "please", and EXCLUDING date/time words.
    Example:
      "remind me to submit assignment at 12:50 today"
      -> reminderMessage: "submit assignment"
  - datetimeISO: a single ISO 8601 datetime string in the user's timezone,
    always in the FUTURE.

DATE/TIME RULES:
- Handle relative time phrases such as:
  - "in 5 minutes", "in 10 mins", "in 2 hours"
- Handle relative days:
  - "today at 7"
  - "tomorrow morning"
  - "day after tomorrow at 8 pm"
- Handle explicit dates:
  - "on 5th May"
  - "on 05/05/2026 at 9 pm"
- If the user gives only a time like "at 12" or "12:30 pm", interpret it as:
  - TODAY at that time, if the time is still in the future in the given timezone
  - otherwise, TOMORROW at that time.
- If the user only mentions a date like "on 5th May" without a time,
  choose 09:00 in their timezone as the time.
- Always return a specific future datetime in datetimeISO.

If it is not a reminder request, mark intent as "other".

STRICT RULES:
- Respond with ONLY valid JSON, no extra text, no explanations.
- JSON shape:

{
  "intent": "create_reminder" | "other",
  "reminderMessage": string | null,
  "datetimeISO": string | null,
  "confidence": number
}
`.trim();

  try {
    const result = await model.generateContent(prompt);
    const textResponse = result.response.text();

    let parsed: ParsedReminder;
    try {
      parsed = JSON.parse(textResponse) as ParsedReminder;
    } catch (err) {
      console.error("Gemini returned non-JSON:", textResponse);
      return null;
    }

    if (!parsed.intent) return null;
    return parsed;
  } catch (err) {
    console.error("Error calling Gemini:", err);
    return null;
  }
}
