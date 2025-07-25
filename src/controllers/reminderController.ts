// src/controllers/reminderController.ts
import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

export async function createReminder(req: Request, res: Response) {
  const { userId, message, remindAt } = req.body;
  if (!userId || !message || !remindAt)
    return res.status(400).json({ error: "Missing fields" });

  const reminder = await prisma.reminder.create({
    data: { userId, message, remindAt: new Date(remindAt) },
  });
  res.json(reminder);
}
