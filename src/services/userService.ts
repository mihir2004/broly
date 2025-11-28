// User service responsible for resolving Twilio users to DB users.

import { User } from "@prisma/client";
import { prisma } from "../prisma";

interface TwilioBody {
  From?: string; // "whatsapp:+91..."
  ProfileName?: string; // "Mihir Kasare"
  [key: string]: any;
}

/**
 * Get or create a User based on Twilio webhook payload.
 * Uses "From" (WhatsApp number) as the unique identifier.
 */
export async function getOrCreateUserFromTwilio(
  body: TwilioBody
): Promise<User> {
  const from = body.From;
  const profileName = body.ProfileName;

  if (!from) {
    throw new Error("Missing 'From' in Twilio payload");
  }

  const user = await prisma.user.upsert({
    where: { whatsappNumber: from },
    update: {
      profileName,
    },
    create: {
      whatsappNumber: from,
      profileName,
    },
  });

  return user;
}
