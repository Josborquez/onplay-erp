import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { resetDb, loginAs } from "./helpers.js";

const app = createApp();

async function admin() {
  return loginAs(app, request, {
    email: `admin-${Date.now()}-${Math.random()}@onplay.cl`,
    role: "STORE_ADMIN",
  });
}

async function createProduct(token, body) {
  const res = await request(app)
    .post("/api/products")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
  expect(res.status).toBe(201);
  return res.body;
}

function getProduct(token, id) {
  return request(app)
    .get(`/api/products/${id}`)
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

describe("Bloque 2D — costo en la compra (§5.2/§7)", () => {
  // 1. Bulk: el costo total se reparte ponderado por el precio de venta, y el
  //    margen por carta queda visible.
  it("1) reparte el costo de un bulk ponderado por precio de venta", async () => {
    const { token } = await admin();
    const a = await createProduct(token, { type: "SINGLE", name: "Carta A", precio: 1000 });
    const b = await createProduct(token, { type: "SINGLE", name: "Carta B", precio: 4000 });

    // Σvalor = 1000 + 4000 = 5000; total 2500 → A:500, B:2000 (proporción 1:4).
    const res = await request(app)
      .post("/api/inventory/cost/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ totalCost: 2500, items: [{ productId: a.id }, { productId: b.id }] });
    expect(res.status).toBe(200);
    expect(res.body.sumValue).toBe(5000);

    const byId = Object.fromEntries(res.body.items.map((i) => [i.productId, i]));
    expect(byId[a.id]).toMatchObject({ costo: 500, margen: 500 });
    expect(byId[b.id]).toMatchObject({ costo: 2000, margen: 2000 });

    // El margen queda calculado al leer el producto.
    const got = await getProduct(token, b.id);
    expect(got.body).toMatchObject({ costo: 2000, precio: 4000, margen: 2000 });
  });

  // 2. El reparto pondera por cantidad × precio (líneas con varias copias).
  it("2) pondera por cantidad × precio", async () => {
    const { token } = await admin();
    const a = await createProduct(token, { type: "SINGLE", name: "Común", precio: 1000 });
    const b = await createProduct(token, { type: "SINGLE", name: "Rara", precio: 3000 });

    // Σvalor = 2×1000 + 1×3000 = 5000; total 2500 → A:500/u, B:1500/u.
    const res = await request(app)
      .post("/api/inventory/cost/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({
        totalCost: 2500,
        items: [
          { productId: a.id, quantity: 2 },
          { productId: b.id, quantity: 1 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.sumValue).toBe(5000);
    const byId = Object.fromEntries(res.body.items.map((i) => [i.productId, i]));
    expect(byId[a.id]).toMatchObject({ costo: 500, lineCost: 1000 });
    expect(byId[b.id]).toMatchObject({ costo: 1500, lineCost: 1500 });
  });

  // 3. Trade: costo = referencia × multiplicador de compra (default 400).
  it("3) calcula el costo de un trade desde la referencia", async () => {
    const { token } = await admin();
    // referencia 2.00 USD → precio sugerido 2.00×1000=2000; costo trade 2.00×400=800.
    const card = await createProduct(token, { type: "SINGLE", name: "Trade Card", referencePrice: 2.0 });
    expect(card.precio).toBe(2000);

    const res = await request(app)
      .post("/api/inventory/cost/trade")
      .set("Authorization", `Bearer ${token}`)
      .send({ productId: card.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ costo: 800, precio: 2000, margen: 1200 });

    const got = await getProduct(token, card.id);
    expect(got.body).toMatchObject({ costo: 800, margen: 1200 });
  });

  // 4. Bulk con un producto sin precio de venta → 400 (no se puede ponderar).
  it("4) rechaza un bulk si una carta no tiene precio de venta", async () => {
    const { token } = await admin();
    const a = await createProduct(token, { type: "SINGLE", name: "Con precio", precio: 1000 });
    const sinPrecio = await createProduct(token, { type: "SEALED", name: "Caja sin precio" });
    expect(sinPrecio.precio).toBeNull();

    const res = await request(app)
      .post("/api/inventory/cost/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ totalCost: 1000, items: [{ productId: a.id }, { productId: sinPrecio.id }] });
    expect(res.status).toBe(400);
  });

  // 5. Guarda por rol: un Sales assistant no puede asignar costo (403).
  it("5) un rol sin permiso no puede asignar costo (403)", async () => {
    const { token: adminTok } = await admin();
    const a = await createProduct(adminTok, { type: "SINGLE", name: "X", precio: 1000 });

    const { token } = await loginAs(app, request, {
      email: `sales-${Date.now()}@onplay.cl`,
      role: "SALES_ASSISTANT",
    });
    const res = await request(app)
      .post("/api/inventory/cost/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ totalCost: 1000, items: [{ productId: a.id }] });
    expect(res.status).toBe(403);
  });
});
