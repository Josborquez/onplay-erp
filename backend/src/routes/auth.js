import { Router } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { verifyPassword } from "../lib/password.js";
import { verifyPin } from "../lib/pin.js";
import { signSession } from "../lib/jwt.js";
import { verifyGoogleIdToken } from "../lib/google.js";
import { requireAuth, requireSession } from "../middleware/auth.js";
import { audit } from "../services/audit.js";

export const authRouter = Router();

// Rate limit en login (§7): frena fuerza bruta sin revelar nada.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "demasiados intentos, intente más tarde" },
});

// Crea una sesión nueva para un usuario y devuelve el token firmado.
async function startSession(userId) {
  const now = new Date();
  const absoluteExpiresAt = new Date(
    now.getTime() + config.sessionAbsoluteHours * 60 * 60 * 1000
  );
  const session = await prisma.session.create({
    data: { userId, absoluteExpiresAt, lastActivityAt: now },
  });
  return signSession(session.id);
}

// POST /api/auth/login — correo + clave (R: §3.1).
authRouter.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(401).json({ error: "acceso no autorizado" });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    // Verificamos la clave siempre que haya hash, incluso si el usuario está
    // inactivo, para no filtrar por tiempo de respuesta. Resultado: mensaje
    // genérico en cualquier fallo (R4).
    const ok = user
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, null);

    if (!user || !user.isActive || !ok) {
      await audit("LOGIN_FAILED", {
        userId: user ? user.id : null,
        detail: email,
      });
      return res.status(401).json({ error: "acceso no autorizado" });
    }

    const token = await startSession(user.id);
    await audit("LOGIN", { userId: user.id });
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/google — login con cuenta de Google (R: §3.1, R1/R2).
authRouter.post("/google", loginLimiter, async (req, res, next) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) {
      return res.status(401).json({ error: "acceso no autorizado" });
    }

    const profile = await verifyGoogleIdToken(idToken);
    if (!profile) {
      await audit("LOGIN_FAILED", { detail: "google:token_invalido" });
      return res.status(401).json({ error: "acceso no autorizado" });
    }

    // R1: NO se crean usuarios por login Google. Solo pre-registrados activos.
    const user = await prisma.user.findUnique({ where: { email: profile.email } });
    if (!user || !user.isActive) {
      await audit("LOGIN_FAILED", {
        userId: user ? user.id : null,
        detail: `google:${profile.email}`,
      });
      return res.status(401).json({ error: "acceso no autorizado" });
    }

    // Vinculamos el googleSub la primera vez (no es un alta, es un enlace).
    if (!user.googleSub) {
      await prisma.user.update({
        where: { id: user.id },
        data: { googleSub: profile.sub },
      });
    }

    const token = await startSession(user.id);
    await audit("LOGIN_GOOGLE", { userId: user.id });
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/unlock — desbloqueo de pantalla con PIN (R: §3.3/§3.4).
// Usa requireSession: debe funcionar con la pantalla bloqueada.
authRouter.post("/unlock", requireSession, async (req, res, next) => {
  try {
    const { pin } = req.body || {};
    const { user, session } = req.auth;

    const ok = pin ? await verifyPin(pin, user.pinHash) : false;
    if (!ok) {
      await audit("UNLOCK_FAILED", { userId: user.id });
      return res.status(423).json({ error: "PIN incorrecto", locked: true });
    }

    await prisma.session.update({
      where: { id: session.id },
      data: { lastActivityAt: new Date() },
    });
    await audit("UNLOCK", { userId: user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout — cierra la sesión por completo (R: §3.2/§3.6).
authRouter.post("/logout", requireSession, async (req, res, next) => {
  try {
    const { session, user } = req.auth;
    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    await audit("LOGOUT", { userId: user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me — datos no sensibles de la sesión actual.
authRouter.get("/me", requireAuth, (req, res) => {
  const { user } = req.auth;
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});
