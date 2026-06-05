import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { getAllSettings, setSetting } from "../services/settings.js";

export const settingsRouter = Router();

const canWrite = requireRole("SUPER_ADMIN", "STORE_ADMIN");

// GET /api/settings — todos los parámetros de negocio actuales (§5.3).
settingsRouter.get("/settings", requireAuth, async (req, res, next) => {
  try {
    res.json(await getAllSettings());
  } catch (err) {
    next(err);
  }
});

// PATCH /api/settings/:key — edita un parámetro en runtime (§5.3, §7).
settingsRouter.patch("/settings/:key", requireAuth, canWrite, async (req, res, next) => {
  try {
    const value = await setSetting(req.params.key, req.body?.value);
    res.json({ key: req.params.key, value });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});
