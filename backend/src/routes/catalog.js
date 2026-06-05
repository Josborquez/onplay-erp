import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import {
  createProduct,
  updateProduct,
  listProducts,
  getProduct,
} from "../services/catalog.js";

export const catalogRouter = Router();

// Escritura del catálogo: solo administración (Super admin / Admin tienda).
const canWrite = requireRole("SUPER_ADMIN", "STORE_ADMIN");

// Traduce errores de validación (con .status) a su código; el resto al 500.
function fail(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

// ── Juegos (mínimo para poder asociar singles a su juego) ──────────────
catalogRouter.post("/games", requireAuth, canWrite, async (req, res, next) => {
  try {
    const { name, referencePriceSource } = req.body || {};
    if (!name || !referencePriceSource) {
      return res.status(400).json({ error: "name y referencePriceSource requeridos" });
    }
    const game = await prisma.game.create({ data: { name, referencePriceSource } });
    res.status(201).json(game);
  } catch (err) {
    fail(err, res, next);
  }
});

catalogRouter.get("/games", requireAuth, async (req, res, next) => {
  try {
    res.json(await prisma.game.findMany({ orderBy: { id: "asc" } }));
  } catch (err) {
    next(err);
  }
});

// ── Productos ──────────────────────────────────────────────────────────
catalogRouter.post("/products", requireAuth, canWrite, async (req, res, next) => {
  try {
    const product = await createProduct(req.body || {});
    res.status(201).json(product);
  } catch (err) {
    fail(err, res, next);
  }
});

catalogRouter.get("/products", requireAuth, async (req, res, next) => {
  try {
    res.json(await listProducts());
  } catch (err) {
    next(err);
  }
});

catalogRouter.get("/products/:id", requireAuth, async (req, res, next) => {
  try {
    const product = await getProduct(Number(req.params.id));
    if (!product) return res.status(404).json({ error: "no encontrado" });
    res.json(product);
  } catch (err) {
    next(err);
  }
});

catalogRouter.patch("/products/:id", requireAuth, canWrite, async (req, res, next) => {
  try {
    const product = await updateProduct(Number(req.params.id), req.body || {});
    res.json(product);
  } catch (err) {
    fail(err, res, next);
  }
});
