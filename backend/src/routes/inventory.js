import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import {
  addStock,
  reserve,
  confirm,
  release,
  getStockStatus,
} from "../services/inventory.js";
import { importManabox } from "../services/manabox.js";
import { applyTradeCost, distributeBulkCost } from "../services/costing.js";

export const inventoryRouter = Router();

// Cargar stock es administración; reservar/confirmar/liberar lo hace cualquier
// staff (el vendedor reserva al vender).
const canWrite = requireRole("SUPER_ADMIN", "STORE_ADMIN");

// Traduce errores con .status a su código; el resto al 500 (igual que catalog.js).
function fail(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

// POST /api/inventory/stock — ENTRADA de stock (carga).
inventoryRouter.post("/inventory/stock", requireAuth, canWrite, async (req, res, next) => {
  try {
    const { productId, quantity, locationId } = req.body || {};
    const status = await addStock(productId, quantity, {
      locationId,
      userId: req.auth.user.id,
    });
    res.status(201).json(status);
  } catch (err) {
    fail(err, res, next);
  }
});

// POST /api/inventory/import/manabox — importa singles de Magic desde el CSV
// de ManaBox (body: text/csv). Idempotente por lote (2C §6).
inventoryRouter.post(
  "/inventory/import/manabox",
  requireAuth,
  canWrite,
  async (req, res, next) => {
    try {
      const csv = typeof req.body === "string" ? req.body : req.body?.csv;
      const summary = await importManabox(csv, { userId: req.auth.user.id });
      res.status(summary.alreadyImported ? 200 : 201).json(summary);
    } catch (err) {
      fail(err, res, next);
    }
  }
);

// POST /api/inventory/cost/trade — costo de trade (referencia × buy_multiplier).
inventoryRouter.post("/inventory/cost/trade", requireAuth, canWrite, async (req, res, next) => {
  try {
    const { productId, referencePrice } = req.body || {};
    const result = await applyTradeCost(productId, { referencePrice });
    res.json(result);
  } catch (err) {
    fail(err, res, next);
  }
});

// POST /api/inventory/cost/bulk — reparte el costo total de un lote ponderado
// por el precio de venta de cada carta.
inventoryRouter.post("/inventory/cost/bulk", requireAuth, canWrite, async (req, res, next) => {
  try {
    const { items, totalCost } = req.body || {};
    const result = await distributeBulkCost(items, totalCost);
    res.json(result);
  } catch (err) {
    fail(err, res, next);
  }
});

// POST /api/inventory/reserve — reserva bajo candado de fila.
inventoryRouter.post("/inventory/reserve", requireAuth, async (req, res, next) => {
  try {
    const { productId, quantity, locationId } = req.body || {};
    const reservation = await reserve(productId, quantity, {
      locationId,
      userId: req.auth.user.id,
    });
    res.status(201).json(reservation);
  } catch (err) {
    fail(err, res, next);
  }
});

// POST /api/inventory/reservations/:id/confirm — confirma la venta.
inventoryRouter.post(
  "/inventory/reservations/:id/confirm",
  requireAuth,
  async (req, res, next) => {
    try {
      const reservation = await confirm(Number(req.params.id), {
        userId: req.auth.user.id,
      });
      res.json(reservation);
    } catch (err) {
      fail(err, res, next);
    }
  }
);

// POST /api/inventory/reservations/:id/release — libera la reserva.
inventoryRouter.post(
  "/inventory/reservations/:id/release",
  requireAuth,
  async (req, res, next) => {
    try {
      const reservation = await release(Number(req.params.id));
      res.json(reservation);
    } catch (err) {
      fail(err, res, next);
    }
  }
);

// GET /api/inventory/products/:id/stock — estado de stock del producto.
inventoryRouter.get(
  "/inventory/products/:id/stock",
  requireAuth,
  async (req, res, next) => {
    try {
      const status = await getStockStatus(Number(req.params.id), {
        locationId: req.query.locationId ? Number(req.query.locationId) : undefined,
      });
      res.json(status);
    } catch (err) {
      fail(err, res, next);
    }
  }
);
