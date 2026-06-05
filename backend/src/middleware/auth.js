import { prisma } from "../db.js";
import { config } from "../config.js";
import { verifySession } from "../lib/jwt.js";

// Extrae el token "Bearer xxx" del header Authorization.
function getToken(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

// Carga la sesión + usuario a partir del JWT. Aplica las invariantes comunes:
//   - JWT inválido / sin sesión / sesión revocada / usuario inactivo → 401
//   - sesión pasada de su expiración absoluta → 401 (y se revoca)
// No evalúa inactividad: eso lo decide cada guard.
// Devuelve { session, user } o lanza un objeto { status, message }.
async function loadSession(req) {
  const token = getToken(req);
  if (!token) throw { status: 401, message: "acceso no autorizado" };

  const payload = verifySession(token);
  if (!payload || !payload.sessionId) {
    throw { status: 401, message: "acceso no autorizado" };
  }

  const session = await prisma.session.findUnique({
    where: { id: payload.sessionId },
    include: { user: true },
  });

  if (!session || session.revokedAt || !session.user || !session.user.isActive) {
    throw { status: 401, message: "acceso no autorizado" };
  }

  const now = new Date();
  if (now > session.absoluteExpiresAt) {
    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: now },
    });
    throw { status: 401, message: "acceso no autorizado" };
  }

  return { session, user: session.user, now };
}

// Guard estándar de endpoints protegidos: además de validar la sesión, aplica
// el bloqueo por inactividad (R3). Si pasó el umbral → 423 Locked (la sesión NO
// se revoca). Si no, refresca lastActivityAt (actividad reinicia el contador).
export async function requireAuth(req, res, next) {
  try {
    const { session, user, now } = await loadSession(req);

    const idleMs = now - session.lastActivityAt;
    const limitMs = config.inactivityMinutes * 60 * 1000;
    if (idleMs > limitMs) {
      return res
        .status(423)
        .json({ error: "pantalla bloqueada", locked: true });
    }

    await prisma.session.update({
      where: { id: session.id },
      data: { lastActivityAt: now },
    });

    req.auth = { session, user };
    next();
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
}

// Guard para endpoints que deben funcionar con la pantalla bloqueada
// (unlock, logout): valida la sesión pero NO exige inactividad.
export async function requireSession(req, res, next) {
  try {
    const { session, user } = await loadSession(req);
    req.auth = { session, user };
    next();
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
}
