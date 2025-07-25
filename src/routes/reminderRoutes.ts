// src/routes/reminderRoutes.ts
import express from "express";
import { createReminder } from "../controllers/reminderController";

const router = express.Router();

router.post("/reminder", createReminder);

export default router;
