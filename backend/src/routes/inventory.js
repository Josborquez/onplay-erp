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
