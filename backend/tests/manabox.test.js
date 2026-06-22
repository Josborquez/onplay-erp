import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { resetDb, loginAs } from "./helpers.js";

const app = createApp();

// Fixture: CSV de ManaBox con columnas reales. Cubre foil (sufijo), nombre con
// coma (campo entre comillas), condición/idioma distintos, cantidad>1 y una
// fila sin Purchase price (precio nulo).
const CSV = [
  "Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency",
  "Sol Ring,EOE,Edge of Eternities,308,normal,rare,2,1001,a1b2c3d4-0000-0000-0000-000000000001,1.50,false,false,near_mint,en,USD",
  "Lightning Bolt,M11,Magic 2011,149,foil,common,1,1002,f9e8d7c6-0000-0000-0000-000000000002,0.80,false,false,near_mint,en,USD",
  '"Borborygmos, Enraged",GTC,Gatecrash,159,normal,mythic,3,1003,12345678-0000-0000-0000-000000000003,0.25,false,false,lightly_played,es,USD',
  "Forest,EOE,Edge of Eternities,280,normal,common,5,1004,abcdef01-0000-0000-0000-000000000004,,false,false,near_mint,en,USD",
].join("\n");

async function admin() {
  return loginAs(app, request, {
    email: `admin-${Date.now()}-${Math.random()}@onplay.cl`,
    role: "STORE_ADMIN",
  });
}

function importReq(token, csv) {
  return request(app)
    .post("/api/inventory/import/manabox")
    .set("Authorization", `Bearer ${token}`)
    .set("Content-Type", "text/csv")
    .send(csv);
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

describe("Bloque 2C — importación ManaBox (§6/§7)", () => {
  // 1. Importar crea los singles con SKU, atributos, precio de venta, imagen
  //    Scryfall y sufijo (Foil); el stock entra como unidades DISPONIBLE.
  it("1) importa el CSV creando singles con sus atributos y stock", async () => {
    const { user, token } = await admin();
    const res = await importReq(token, CSV);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      alreadyImported: false,
      created: 4,
      updated: 0,
      unitsAdded: 11,
      rowCount: 4,
    });

    // Juego Magic get-or-create.
    const game = await prisma.game.findUnique({ where: { name: "Magic: The Gathering" } });
    expect(game).not.toBeNull();

    // Single normal: SKU, precio sugerido (1.50 × 1000 → ceil_500 = 1500), imagen.
    const sol = await prisma.product.findUnique({ where: { sku: "EOE-308-NM-EN" } });
    expect(sol).toMatchObject({
      type: "SINGLE",
      trackingMode: "UNIDAD",
      name: "Sol Ring",
      foil: false,
      rarity: "rare",
      condition: "NM",
      language: "Inglés",
      precio: 1500,
      gameId: game.id,
    });
    expect(Number(sol.referencePrice)).toBe(1.5);
    expect(sol.imageUrl).toBe(
      "https://cards.scryfall.io/normal/front/a/1/a1b2c3d4-0000-0000-0000-000000000001.jpg"
    );
    expect(await prisma.stockUnit.count({ where: { productId: sol.id, state: "DISPONIBLE" } })).toBe(2);

    // Foil: sufijo (Foil) en el nombre y foil=true (0.80 × 1000 → 1000).
    const bolt = await prisma.product.findUnique({ where: { sku: "M11-149-NM-EN" } });
    expect(bolt).toMatchObject({ name: "Lightning Bolt (Foil)", foil: true, precio: 1000 });

    // Nombre con coma (campo entre comillas) + condición/idioma mapeados.
    const borb = await prisma.product.findUnique({ where: { sku: "GTC-159-LP-ES" } });
    expect(borb).toMatchObject({
      name: "Borborygmos, Enraged",
      condition: "LP",
      language: "Español",
      precio: 500,
    });

    // Fila sin Purchase price → precio y referencia nulos.
    const forest = await prisma.product.findUnique({ where: { sku: "EOE-280-NM-EN" } });
    expect(forest.precio).toBeNull();
    expect(forest.referencePrice).toBeNull();

    // Stock total y movimientos ENTRADA (uno por fila, con usuario).
    expect(await prisma.stockUnit.count()).toBe(11);
    const entradas = await prisma.stockMovement.findMany({ where: { type: "ENTRADA" } });
    expect(entradas).toHaveLength(4);
    for (const m of entradas) expect(m.userId).toBe(user.id);
  });

  // 2. Reimportar el mismo CSV es idempotente: no duplica stock ni productos.
  it("2) reimportar el mismo CSV no duplica stock", async () => {
    const { token } = await admin();
    await importReq(token, CSV).expect(201);

    const res = await importReq(token, CSV);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyImported: true, created: 0, updated: 0, unitsAdded: 0 });

    expect(await prisma.product.count()).toBe(4);
    expect(await prisma.stockUnit.count()).toBe(11);
    expect(await prisma.importBatch.count()).toBe(1);
  });

  // 3. Guarda por rol: un Sales assistant no puede importar (403).
  it("3) un rol sin permiso no puede importar (403)", async () => {
    const { token } = await loginAs(app, request, {
      email: `sales-${Date.now()}@onplay.cl`,
      role: "SALES_ASSISTANT",
    });
    const res = await importReq(token, CSV);
    expect(res.status).toBe(403);
  });
});
