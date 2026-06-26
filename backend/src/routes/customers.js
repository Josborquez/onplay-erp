import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import {
  createCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
  setActivo,
} from "../services/customers.js";

export const customersRouter = Router();

// Alta de clientes en mostrador: la opera el vendedor. Editar/deshabilitar es
// administración.
const canOperate = requireRole("SALES_ASSISTANT", "STORE_ADMIN", "SUPER_ADMIN");
const canAdmin = requireRole("STORE_ADMIN", "SUPER_ADMIN");

function fail(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

// POST /api/customers — alta (crea el cliente y su wallet en saldo 0).
customersRouter.post("/customers", requireAuth, canOperate, async (req, res, next) => {
  try {
    const customer = await createCustomer(req.body || {});
    res.status(201).json(customer);
  } catch (err) {
    fail(err, res, next);
  }
});

// GET /api/customers?q= — listado/búsqueda por nombre/rut/email.
customersRouter.get("/customers", requireAuth, async (req, res, next) => {
  try {
    res.json(await listCustomers({ q: req.query.q }));
  } catch (err) {
    fail(err, res, next);
  }
});

// GET /api/customers/:id — detalle con su wallet.
customersRouter.get("/customers/:id", requireAuth, async (req, res, next) => {
  try {
    res.json(await getCustomer(Number(req.params.id)));
  } catch (err) {
    fail(err, res, next);
  }
});

// PATCH /api/customers/:id — edita datos de contacto (admin).
customersRouter.patch("/customers/:id", requireAuth, canAdmin, async (req, res, next) => {
  try {
    res.json(await updateCustomer(Number(req.params.id), req.body || {}));
  } catch (err) {
    fail(err, res, next);
  }
});

// PATCH /api/customers/:id/activo — soft-disable / re-enable (admin).
customersRouter.patch("/customers/:id/activo", requireAuth, canAdmin, async (req, res, next) => {
  try {
    res.json(await setActivo(Number(req.params.id), (req.body || {}).activo));
  } catch (err) {
    fail(err, res, next);
  }
});
