import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { resetDb, loginAs } from "./helpers.js";

const app = createApp();

// Token de un administrador con permiso de escritura del catálogo.
async function adminToken() {
  const { token } = await loginAs(app, request, {
    email: `admin-${Date.now()}-${Math.random()}@onplay.cl`,
    role: "STORE_ADMIN",
  });
  return token;
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

describe("Bloque 2A — catálogo, margen y Settings (§7)", () => {
  // 1. Crear un producto de cada tipo con costo y precio.
  it("1) crea un producto de cada tipo con costo y precio", async () => {
    const token = await adminToken();
    const tipos = [
      { type: "SINGLE", name: "Black Lotus", costo: 1000, precio: 2500 },
      { type: "SEALED", name: "Caja Booster", costo: 30000, precio: 60000 },
      { type: "SNACK", name: "Papas", costo: 500, precio: 1000 },
      { type: "ACCESSORY", name: "Fundas", costo: 2000, precio: 5000 },
    ];
    for (const body of tipos) {
      const res = await request(app)
        .post("/api/products")
        .set("Authorization", `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(201);
      expect(res.body.type).toBe(body.type);
      // El modo de rastreo se deriva del tipo (§2.2).
      expect(res.body.trackingMode).toBe(body.type === "SINGLE" ? "UNIDAD" : "CANTIDAD");
    }
  });

  // 2. El sistema calcula margen = precio − costo.
  it("2) calcula margen = precio − costo", async () => {
    const token = await adminToken();
    const create = await request(app)
      .post("/api/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "SEALED", name: "Bundle", costo: 18000, precio: 32000 });
    expect(create.body.margen).toBe(14000);

    const get = await request(app)
      .get(`/api/products/${create.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body.margen).toBe(14000);
  });

  // 3. Single: precio sugerido = referencia × multiplicador de venta, redondeado.
  it("3) single calcula precio sugerido desde la referencia y los Settings", async () => {
    const token = await adminToken();
    // Default: sale_multiplier=1000, rounding=ceil_500. 2.3 × 1000 = 2300 → 2500.
    const res = await request(app)
      .post("/api/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "SINGLE", name: "Sol Ring", referencePrice: 2.3 });
    expect(res.status).toBe(201);
    expect(res.body.precio).toBe(2500);
  });

  // 4. El single es ajustable a mano (precio explícito gana sobre el sugerido).
  it("4) un precio explícito anula el sugerido", async () => {
    const token = await adminToken();
    const res = await request(app)
      .post("/api/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "SINGLE", name: "Mox", referencePrice: 2.3, precio: 9000 });
    expect(res.body.precio).toBe(9000);
  });

  // 5. Editar un multiplicador en Settings cambia el precio sugerido (runtime).
  it("5) editar sale_multiplier en Settings cambia el precio sugerido", async () => {
    const token = await adminToken();
    const patch = await request(app)
      .patch("/api/settings/sale_multiplier")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: 2000 });
    expect(patch.status).toBe(200);
    expect(patch.body.value).toBe(2000);

    // 2.3 × 2000 = 4600 → ceil_500 → 5000.
    const res = await request(app)
      .post("/api/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "SINGLE", name: "Time Walk", referencePrice: 2.3 });
    expect(res.body.precio).toBe(5000);
  });

  // 6. GET /settings devuelve los parámetros (defaults si no hay nada guardado).
  it("6) GET /settings devuelve los parámetros de negocio", async () => {
    const token = await adminToken();
    const res = await request(app)
      .get("/api/settings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.sale_multiplier).toBe(1000);
    expect(res.body.buy_multiplier).toBe(400);
    expect(res.body.rounding_rule).toBe("ceil_500");
    expect(res.body.reservation_ttl_minutes).toBe(30);
  });

  // 7. Validación: un valor de enum inválido en Settings → 400.
  it("7) un valor inválido en Settings es rechazado", async () => {
    const token = await adminToken();
    const res = await request(app)
      .patch("/api/settings/rounding_rule")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "ceil_777" });
    expect(res.status).toBe(400);
  });

  // 8. Guarda por rol: un Sales assistant no puede escribir el catálogo (403).
  it("8) un rol sin permiso no puede crear productos (403)", async () => {
    const { token } = await loginAs(app, request, {
      email: `sales-${Date.now()}@onplay.cl`,
      role: "SALES_ASSISTANT",
    });
    const res = await request(app)
      .post("/api/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "SNACK", name: "Bebida", costo: 300, precio: 800 });
    expect(res.status).toBe(403);
  });

  // 9. Un single puede asociarse a un juego (con su fuente de precio).
  it("9) crea un juego y asocia un single a él", async () => {
    const token = await adminToken();
    const game = await request(app)
      .post("/api/games")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Magic", referencePriceSource: "CardKingdom" });
    expect(game.status).toBe(201);

    const single = await request(app)
      .post("/api/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "SINGLE", name: "Lightning Bolt", gameId: game.body.id, precio: 1500 });
    expect(single.status).toBe(201);
    expect(single.body.gameId).toBe(game.body.id);
  });
});
