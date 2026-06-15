import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { resetDb, loginAs } from "./helpers.js";
import { expireReservations } from "../src/services/inventory.js";

const app = createApp();

// Administrador con permiso de carga de stock. Devuelve {user, token}.
async function admin() {
  return loginAs(app, request, {
    email: `admin-${Date.now()}-${Math.random()}@onplay.cl`,
    role: "STORE_ADMIN",
  });
}

// Crea un producto y devuelve su id. type SINGLE → modo UNIDAD; resto CANTIDAD.
async function createProduct(token, body) {
  const res = await request(app)
    .post("/api/products")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
  expect(res.status).toBe(201);
  return res.body.id;
}

function reserveReq(token, body) {
  return request(app)
    .post("/api/inventory/reserve")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

function stockReq(token, productId) {
  return request(app)
    .get(`/api/inventory/products/${productId}/stock`)
    .set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Bloque 2B — motor de inventario (§7)", () => {
  // 1. addStock: UNIDAD crea N unidades DISPONIBLE; CANTIDAD incrementa available.
  it("1) carga stock en ambos modos de rastreo", async () => {
    const { token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Black Lotus", precio: 1000 });
    const sealed = await createProduct(token, { type: "SEALED", name: "Booster", precio: 5000 });

    await request(app)
      .post("/api/inventory/stock")
      .set("Authorization", `Bearer ${token}`)
      .send({ productId: single, quantity: 3 })
      .expect(201);
    expect(await prisma.stockUnit.count({ where: { productId: single, state: "DISPONIBLE" } })).toBe(3);

    await request(app)
      .post("/api/inventory/stock")
      .set("Authorization", `Bearer ${token}`)
      .send({ productId: sealed, quantity: 10 })
      .expect(201);
    const status = await stockReq(token, sealed);
    expect(status.body.available).toBe(10);
  });

  // 2. reserve UNIDAD → unidad RESERVADA; available−1, reserved+1.
  it("2) reservar una unidad la deja RESERVADA", async () => {
    const { token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Mox", precio: 1000 });
    await request(app)
      .post("/api/inventory/stock")
      .set("Authorization", `Bearer ${token}`)
      .send({ productId: single, quantity: 2 });

    const res = await reserveReq(token, { productId: single, quantity: 1 });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("ACTIVA");

    const status = await stockReq(token, single);
    expect(status.body.available).toBe(1);
    expect(status.body.reserved).toBe(1);
  });

  // 3. reserve CANTIDAD mueve N de available a reserved.
  it("3) reservar cantidad mueve de available a reserved", async () => {
    const { token } = await admin();
    const sealed = await createProduct(token, { type: "SEALED", name: "Bundle", precio: 5000 });
    await request(app)
      .post("/api/inventory/stock")
      .set("Authorization", `Bearer ${token}`)
      .send({ productId: sealed, quantity: 10 });

    const res = await reserveReq(token, { productId: sealed, quantity: 4 });
    expect(res.status).toBe(201);

    const status = await stockReq(token, sealed);
    expect(status.body.available).toBe(6);
    expect(status.body.reserved).toBe(4);
  });

  // 4. Doble reserva sobre la última unidad: exactamente uno gana (candado).
  it("4) dos reservas concurrentes sobre la última unidad → 1 ok, 1 rechazada", async () => {
    const { token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Time Walk", precio: 1000 });
    await request(app)
      .post("/api/inventory/stock")
      .set("Authorization", `Bearer ${token}`)
      .send({ productId: single, quantity: 1 });

    const results = await Promise.allSettled([
      reserveReq(token, { productId: single, quantity: 1 }),
      reserveReq(token, { productId: single, quantity: 1 }),
    ]);
    const codes = results.map((r) => (r.status === "fulfilled" ? r.value.status : 500)).sort();
    expect(codes).toEqual([201, 409]);

    const status = await stockReq(token, single);
    expect(status.body.available).toBe(0);
    expect(status.body.reserved).toBe(1);
  });

  // 5. confirm → VENDIDA (UNIDAD) y SALIDA registrada.
  it("5) confirmar una reserva la marca CONFIRMADA y la unidad VENDIDA", async () => {
    const { token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Ancestral", precio: 1000 });
    await request(app)
      .post("/api/inventory/stock")
      .set("Authorization", `Bearer ${token}`)
      .send({ productId: single, quantity: 1 });
    const reserved = await reserveReq(token, { productId: single, quantity: 1 });

    const res = await request(app)
      .post(`/api/inventory/reservations/${reserved.body.id}/confirm`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("CONFIRMADA");

    const status = await stockReq(token, single);
    expect(status.body.sold).toBe(1);
    expect(status.body.reserved).toBe(0);

    const salida = await prisma.stockMovement.findFirst({
      where: { productId: single, type: "SALIDA" },
    });
    expect(salida).not.toBeNull();
  });

  // 6. release → vuelve a DISPONIBLE/available.
  it("6) liberar una reserva devuelve el stock", async () => {
    const { token } = await admin();
    const sealed = await createProduct(token, { type: "SEALED", name: "Caja", precio: 5000 });
    await request(app)
      .post("/api/inventory/stock")
      .set("Authorization", `Bearer ${token}`)
      .send({ productId: sealed, quantity: 5 });
    const reserved = await reserveReq(token, { productId: sealed, quantity: 2 });

    const res = await request(app)
      .post(`/api/inventory/reservations/${reserved.body.id}/release`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("LIBERADA");

    const status = await stockReq(token, sealed);
    expect(status.body.available).toBe(5);
    expect(status.body.reserved).toBe(0);
  });

  // 7. reserve insuficiente → 409 sin tocar stock.
  it("7) reservar más de lo disponible → 409 y stock intacto", async () => {
    const { token } = await admin();
    const sealed = await createProduct(token, { type: "SEALED", name: "Display", precio: 5000 });
    await request(app)
      .post("/api/inventory/stock")
      .set("Authorization", `Bearer ${token}`)
      .send({ productId: sealed, quantity: 3 });

    const res = await reserveReq(token, { productId: sealed, quantity: 4 });
    expect(res.status).toBe(409);

    const status = await stockReq(token, sealed);
    expect(status.body.available).toBe(3);
    expect(status.body.reserved).toBe(0);
  });

  // 8. Expiración: reserva vencida → EXPIRADA y stock de vuelta DISPONIBLE.
  it("8) expireReservations libera las reservas vencidas", async () => {
    const { token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Timetwister", precio: 1000 });
    await request(app)
      .post("/api/inventory/stock")
      .set("Authorization", `Bearer ${token}`)
      .send({ productId: single, quantity: 1 });
    const reserved = await reserveReq(token, { productId: single, quantity: 1 });

    // Vencer la reserva moviendo expiresAt al pasado.
    await prisma.reservation.update({
      where: { id: reserved.body.id },
      data: { expiresAt: new Date(Date.now() - 60 * 1000) },
    });

    const freed = await expireReservations();
    expect(freed).toBe(1);

    const reservation = await prisma.reservation.findUnique({ where: { id: reserved.body.id } });
    expect(reservation.state).toBe("EXPIRADA");

    const status = await stockReq(token, single);
    expect(status.body.available).toBe(1);
    expect(status.body.reserved).toBe(0);
  });

  // 9. Movimientos registrados: ENTRADA en carga, SALIDA en confirmación.
  it("9) registra ENTRADA y SALIDA con usuario, tipo, cantidad y fecha", async () => {
    const { user, token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Library", precio: 1000 });
    await request(app)
      .post("/api/inventory/stock")
      .set("Authorization", `Bearer ${token}`)
      .send({ productId: single, quantity: 1 });
    const reserved = await reserveReq(token, { productId: single, quantity: 1 });
    await request(app)
      .post(`/api/inventory/reservations/${reserved.body.id}/confirm`)
      .set("Authorization", `Bearer ${token}`);

    const movimientos = await prisma.stockMovement.findMany({
      where: { productId: single },
      orderBy: { id: "asc" },
    });
    expect(movimientos.map((m) => m.type)).toEqual(["ENTRADA", "SALIDA"]);
    for (const m of movimientos) {
      expect(m.userId).toBe(user.id);
      expect(m.quantity).toBe(1);
      expect(m.createdAt).toBeInstanceOf(Date);
    }
  });

  // 10. Guarda por rol: un Sales assistant no puede cargar stock (403).
  it("10) un rol sin permiso no puede cargar stock (403)", async () => {
    const { token: adminTok } = await admin();
    const single = await createProduct(adminTok, { type: "SINGLE", name: "Mind Twist", precio: 1000 });

    const { token } = await loginAs(app, request, {
      email: `sales-${Date.now()}@onplay.cl`,
      role: "SALES_ASSISTANT",
    });
    const res = await request(app)
      .post("/api/inventory/stock")
      .set("Authorization", `Bearer ${token}`)
      .send({ productId: single, quantity: 5 });
    expect(res.status).toBe(403);
  });
});
