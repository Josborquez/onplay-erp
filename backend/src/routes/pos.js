import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { verifyPin } from "../lib/pin.js";
import {
  createSale,
  addLine,
  removeLine,
  getSale,
  checkout,
  openSession,
  getActiveSession,
  closeSession,
  noSale,
  applyDiscount,
  voidSale,
  listSales,
} from "../services/pos.js";

export const posRouter = Router();

// Operan el POS el asistente de ventas y los administradores. El contador es
// solo lectura (matriz §9); no se le permite ninguna mutación.
const canOperate = requireRole("SALES_ASSISTANT", "STORE_ADMIN", "SUPER_ADMIN");
const canRead = requireRole(
  "SALES_ASSISTANT",
  "STORE_ADMIN",
  "SUPER_ADMIN",
  "ACCOUNTANT"
);
// Anular es una operación de pérdida: solo administradores (matriz §9, AC-3.16).
const canVoid = requireRole("STORE_ADMIN", "SUPER_ADMIN");

// Traduce errores con .status a su código; el resto al 500 (igual que el resto).
function fail(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

// Revalida el PIN propio del usuario autenticado (acciones siempre sensibles:
// anular, no-sale). Responde 403 y devuelve false si no cuadra.
async function checkOwnPin(req, res) {
  const { pin } = req.body || {};
  const ok = await verifyPin(pin ?? "", req.auth.user.pinHash);
  if (!ok) {
    res.status(403).json({ error: "PIN inválido" });
    return false;
  }
  return true;
}

// POST /api/pos/ventas — crea una venta BORRADOR sobre una caja abierta.
posRouter.post("/pos/ventas", requireAuth, canOperate, async (req, res, next) => {
  try {
    const { cashSessionId, customerId } = req.body || {};
    const sale = await createSale(cashSessionId, { userId: req.auth.user.id, customerId });
    res.status(201).json(sale);
  } catch (err) {
    fail(err, res, next);
  }
});

// POST /api/pos/ventas/:id/lineas — agrega una línea (reserva stock).
posRouter.post(
  "/pos/ventas/:id/lineas",
  requireAuth,
  canOperate,
  async (req, res, next) => {
    try {
      const { productId, quantity } = req.body || {};
      const line = await addLine(
        Number(req.params.id),
        { productId, quantity },
        { userId: req.auth.user.id }
      );
      res.status(201).json(line);
    } catch (err) {
      fail(err, res, next);
    }
  }
);

// DELETE /api/pos/ventas/:id/lineas/:lineaId — quita una línea (libera stock).
posRouter.delete(
  "/pos/ventas/:id/lineas/:lineaId",
  requireAuth,
  canOperate,
  async (req, res, next) => {
    try {
      const sale = await removeLine(Number(req.params.id), Number(req.params.lineaId), {
        userId: req.auth.user.id,
      });
      res.json(sale);
    } catch (err) {
      fail(err, res, next);
    }
  }
);

// POST /api/pos/ventas/:id/checkout — cobra y cierra la venta (atómico).
posRouter.post(
  "/pos/ventas/:id/checkout",
  requireAuth,
  canOperate,
  async (req, res, next) => {
    try {
      const { payments } = req.body || {};
      const sale = await checkout(
        Number(req.params.id),
        { payments },
        { userId: req.auth.user.id }
      );
      res.json(sale);
    } catch (err) {
      fail(err, res, next);
    }
  }
);

// GET /api/pos/ventas/:id — detalle de una venta (el contador puede leer).
posRouter.get("/pos/ventas/:id", requireAuth, canRead, async (req, res, next) => {
  try {
    const sale = await getSale(Number(req.params.id));
    res.json(sale);
  } catch (err) {
    fail(err, res, next);
  }
});

// GET /api/pos/ventas — listado con filtros (el contador puede leer).
posRouter.get("/pos/ventas", requireAuth, canRead, async (req, res, next) => {
  try {
    const { cashSessionId, state } = req.query;
    const sales = await listSales({ cashSessionId, state });
    res.json(sales);
  } catch (err) {
    fail(err, res, next);
  }
});

// PATCH /api/pos/ventas/:id/descuento — descuento de línea o de total.
posRouter.patch(
  "/pos/ventas/:id/descuento",
  requireAuth,
  canOperate,
  async (req, res, next) => {
    try {
      const { lineId, lineDiscount, totalDiscount, pin, supervisorId } = req.body || {};
      const sale = await applyDiscount(
        Number(req.params.id),
        { lineId, lineDiscount, totalDiscount, pin, supervisorId },
        { user: req.auth.user }
      );
      res.json(sale);
    } catch (err) {
      fail(err, res, next);
    }
  }
);

// POST /api/pos/ventas/:id/anular — anula intra-sesión (rol admin + PIN propio).
posRouter.post(
  "/pos/ventas/:id/anular",
  requireAuth,
  canVoid,
  async (req, res, next) => {
    try {
      if (!(await checkOwnPin(req, res))) return;
      const { reason } = req.body || {};
      const sale = await voidSale(
        Number(req.params.id),
        { reason },
        { userId: req.auth.user.id }
      );
      res.json(sale);
    } catch (err) {
      fail(err, res, next);
    }
  }
);

// POST /api/pos/sesiones — abre una caja sobre un terminal.
posRouter.post("/pos/sesiones", requireAuth, canOperate, async (req, res, next) => {
  try {
    const { terminalId, openingFloat } = req.body || {};
    const session = await openSession(terminalId, {
      openingFloat,
      userId: req.auth.user.id,
    });
    res.status(201).json(session);
  } catch (err) {
    fail(err, res, next);
  }
});

// GET /api/pos/sesiones/activa — sesión ABIERTA de un terminal (?terminalId=).
posRouter.get(
  "/pos/sesiones/activa",
  requireAuth,
  canRead,
  async (req, res, next) => {
    try {
      const session = await getActiveSession(req.query.terminalId);
      res.json(session);
    } catch (err) {
      fail(err, res, next);
    }
  }
);

// POST /api/pos/sesiones/:id/cerrar — cierra la caja con cuadre (PIN si dif>umbral).
posRouter.post(
  "/pos/sesiones/:id/cerrar",
  requireAuth,
  canOperate,
  async (req, res, next) => {
    try {
      const { countedAmount, pin } = req.body || {};
      const session = await closeSession(
        Number(req.params.id),
        { countedAmount, pin },
        { userId: req.auth.user.id, user: req.auth.user }
      );
      res.json(session);
    } catch (err) {
      fail(err, res, next);
    }
  }
);

// POST /api/pos/sesiones/:id/no-sale — abre el cajón sin venta (PIN propio).
posRouter.post(
  "/pos/sesiones/:id/no-sale",
  requireAuth,
  canOperate,
  async (req, res, next) => {
    try {
      const result = await noSale(
        Number(req.params.id),
        { pin: (req.body || {}).pin },
        { userId: req.auth.user.id, user: req.auth.user }
      );
      res.json(result);
    } catch (err) {
      fail(err, res, next);
    }
  }
);
