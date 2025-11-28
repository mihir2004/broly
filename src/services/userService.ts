// src/services/userService.ts

import { prisma } from "../prisma";

interface TwilioBody {
  From?: string;
  ProfileName?: string;
  [key: string]: any;
}

export async function getOrCreateUserFromTwilio(body: TwilioBody) {
  const from = body.From;
  const profileName = body.ProfileName;

  if (!from) {
    throw new Error("Missing 'From' in Twilio payload");
  }

  const user = await prisma.user.upsert({
    where: { whatsappNumber: from },
    update: { profileName },
    create: { whatsappNumber: from, profileName },
  });

  return user;
}
