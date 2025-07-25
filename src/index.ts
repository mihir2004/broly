import express from "express";
import reminderRoutes from "./routes/reminderRoutes";
import { startBot } from "./bot/whatsapp";
import { startReminderCheck } from "./utils/reminderScheduler";
import dotenv from "dotenv";
import { swaggerDocs } from "./swagger";

dotenv.config();

const app = express();
app.use(express.json());
app.use("/api", reminderRoutes);
app.use("/docs", ...swaggerDocs);

startBot((msg: string, userId: string, sock: any) => {
  if (msg.startsWith("remind me")) {
    const remindTime = new Date(Date.now() + 1 * 60 * 1000); // parse actual time
    const message = msg.replace("remind me to", "").trim();
    // Save via API or direct Prisma
    sock.sendMessage(userId, { text: `✅ Reminder set for: ${message}` });
  }
});

startReminderCheck((userId: string, message: string) => {
  return globalThis.sock?.sendMessage(userId, { text: message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
