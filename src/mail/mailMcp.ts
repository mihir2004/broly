// src/mail/mailMcp.ts
// MCP = Mail Connection Provider for Gmail

import dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } =
  process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
  console.warn(
    "[MailMCP] Google OAuth env vars missing. Gmail login will not work until they are set."
  );
}

export const createOAuthClient = () => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Missing Google OAuth env vars");
  }

  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
};

/**
 * Get the Gmail OAuth consent URL for the user to click.
 */
export const getGmailAuthUrl = (): string => {
  const oAuth2Client = createOAuthClient();

  const scopes = [
    "https://www.googleapis.com/auth/gmail.readonly",
    // We can add more scopes later (calendar, profile, etc.)
  ];

  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline", // to get a refresh token
    prompt: "consent",
    scope: scopes,
  });

  return url;
};

/**
 * Exchange the authorization code for tokens and primary Gmail address.
 */
export const exchangeCodeForTokensAndEmail = async (code: string) => {
  const oAuth2Client = createOAuthClient();

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);

  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  // Get the user profile to know which email address we are connected to
  const profileRes = await gmail.users.getProfile({ userId: "me" });

  const email = profileRes.data.emailAddress;
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;

  if (!email || !accessToken) {
    throw new Error(
      "Failed to obtain email or access token from Google during OAuth exchange."
    );
  }

  return {
    email,
    accessToken,
    refreshToken: refreshToken || "",
  };
};
