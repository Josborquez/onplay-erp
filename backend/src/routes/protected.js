import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";

export const protectedRouter = Router();

// Ruta demo para verificar el guard por rol (403 si el rol no alcanza).
protectedRouter.get(
  "/admin/ping",
  requireAuth,
  requireRole("SUPER_ADMIN"),
  (req, res) => {
    res.json({ pong: true });
  }
);
