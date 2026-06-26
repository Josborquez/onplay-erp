import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { verifyPin } from "../lib/pin.js";
import { getSetting } from "../services/settings.js";
import { audit } from "../services/audit.js";
import { creditar, ajustar, saldoDe, historial } from "../services/wallet.js";

export const walletRouter = Router();

// Leer saldo/historial lo puede hacer también el contador (solo lectura).
// Acreditar lo opera el vendedor (con PIN). Ajustar es solo administración.
const canRead = requireRole("SALES_ASSISTANT", "STORE_ADMIN", "SUPER_ADMIN", "ACCOUNTANT");
const canOperate = requireRole("SALES_ASSISTANT", "STORE_ADMIN", "SUPER_ADMIN");
const canAdmin = requireRole("STORE_ADMIN", "SUPER_ADMIN");

function fail(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

// Revalida el PIN propio del operador autenticado. Responde 403 y false si falla.
async function checkOwnPin(req, res) {
  const ok = await verifyPin((req.body || {}).pin ?? "", req.auth.user.pinHash);
  if (!ok) {
    res.status(403).json({ error: "PIN inválido" });
    return false;
  }
  return true;
}

// Revalida el PIN de un supervisor (admin activo) que autoriza una acreditación
// sobre el umbral. Lanza 403 si no cuadra. Devuelve el supervisor para auditar.
async function requireSupervisorPin(supervisorId, supervisorPin) {
  if (supervisorId == null) throw Object.assign(new Error("se requiere PIN de supervisor"), { status: 403 });
  const sup = await prisma.user.findUnique({ where: { id: Number(supervisorId) } });
  if (!sup || !sup.isActive) throw Object.assign(new Error("supervisor inválido"), { status: 403 });
  if (sup.role !== "STORE_ADMIN" && sup.role !== "SUPER_ADMIN") {
    throw Object.assign(new Error("el supervisor no tiene autorización"), { status: 403 });
  }
  const ok = await verifyPin(supervisorPin ?? "", sup.pinHash);
  if (!ok) throw Object.assign(new Error("PIN de supervisor inválido"), { status: 403 });
  return sup;
}

// GET /api/wallet/:customerId — saldo actual.
walletRouter.get("/wallet/:customerId", requireAuth, canRead, async (req, res, next) => {
  try {
    res.json({ customerId: Number(req.params.customerId), saldo: await saldoDe(req.params.customerId) });
  } catch (err) {
    fail(err, res, next);
  }
});

// GET /api/wallet/:customerId/movimientos — historial paginado.
walletRouter.get("/wallet/:customerId/movimientos", requireAuth, canRead, async (req, res, next) => {
  try {
    const { page, size } = req.query;
    res.json(await historial(req.params.customerId, { page, size }));
  } catch (err) {
    fail(err, res, next);
  }
});

// POST /api/wallet/:customerId/creditar — recarga / carga histórica. PIN propio
// SIEMPRE (acreditar crea dinero); PIN de supervisor si monto > umbral (§8/§9).
walletRouter.post("/wallet/:customerId/creditar", requireAuth, canOperate, async (req, res, next) => {
  try {
    if (!(await checkOwnPin(req, res))) return;
    const { monto, reference, motivo, supervisorId, supervisorPin } = req.body || {};

    const umbral = await getSetting("wallet_acreditacion_pin_supervisor_umbral");
    if (Number(monto) > umbral) await requireSupervisorPin(supervisorId, supervisorPin);

    const dias = await getSetting("wallet_credito_vigencia_dias");
    const expiraEn = dias > 0 ? new Date(Date.now() + dias * 24 * 60 * 60 * 1000) : null;

    const mov = await creditar({
      customerId: Number(req.params.customerId),
      monto,
      origen: "MANUAL",
      reference,
      motivo,
      expiraEn,
      performedBy: req.auth.user.id,
    });
    await audit("wallet_creditar", {
      userId: req.auth.user.id,
      detail: JSON.stringify({ customerId: Number(req.params.customerId), monto: mov.monto, reference }),
    });
    res.status(201).json(mov);
  } catch (err) {
    fail(err, res, next);
  }
});

// POST /api/wallet/:customerId/ajustar — corrección manual (admin + PIN propio +
// motivo obligatorio). El signo (+/-) lo decide el operador.
walletRouter.post("/wallet/:customerId/ajustar", requireAuth, canAdmin, async (req, res, next) => {
  try {
    if (!(await checkOwnPin(req, res))) return;
    const { monto, signo, motivo, reference } = req.body || {};
    const mov = await ajustar({
      customerId: Number(req.params.customerId),
      monto,
      signo,
      motivo,
      reference,
      performedBy: req.auth.user.id,
    });
    await audit("wallet_ajustar", {
      userId: req.auth.user.id,
      detail: JSON.stringify({ customerId: Number(req.params.customerId), monto: mov.monto, signo, reference }),
    });
    res.status(201).json(mov);
  } catch (err) {
    fail(err, res, next);
  }
});
