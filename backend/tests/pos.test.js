import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { resetDb, loginAs } from "./helpers.js";
import { expireReservations } from "../src/services/inventory.js";
import { expireAbandonedSales } from "../src/services/pos.js";

const app = createApp();

// Administrador (puede cargar stock y operar el POS). Devuelve {user, token}.
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
  return res.body.id;
}

async function loadStock(token, productId, quantity) {
  await request(app)
    .post("/api/inventory/stock")
    .set("Authorization", `Bearer ${token}`)
    .send({ productId, quantity })
    .expect(201);
}

// Abre una sesión de caja ABIERTA directo en BD (para los tests 3B/3C que no
// ejercitan el endpoint de apertura).
async function openSession(userId) {
  const terminal = await prisma.terminal.create({
    data: { name: `T-${Date.now()}-${Math.random()}` },
  });
  return prisma.cashSession.create({
    data: { terminalId: terminal.id, openedById: userId, openingFloat: 0 },
  });
}

// Usuarios de roles concretos para las matrices del 3D. PIN por defecto "4321".
async function assistant() {
  return loginAs(app, request, {
    email: `sa-${Date.now()}-${Math.random()}@onplay.cl`,
    role: "SALES_ASSISTANT",
  });
}
async function accountant() {
  return loginAs(app, request, {
    email: `acc-${Date.now()}-${Math.random()}@onplay.cl`,
    role: "ACCOUNTANT",
  });
}

async function createTerminal() {
  return prisma.terminal.create({
    data: { name: `T-${Date.now()}-${Math.random()}` },
  });
}

function openSessionReq(token, terminalId, openingFloat) {
  return request(app)
    .post("/api/pos/sesiones")
    .set("Authorization", `Bearer ${token}`)
    .send({ terminalId, openingFloat });
}
function closeReq(token, sessionId, countedAmount, pin) {
  return request(app)
    .post(`/api/pos/sesiones/${sessionId}/cerrar`)
    .set("Authorization", `Bearer ${token}`)
    .send({ countedAmount, pin });
}
function discountReq(token, saleId, body) {
  return request(app)
    .patch(`/api/pos/ventas/${saleId}/descuento`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}
function anularReq(token, saleId, body) {
  return request(app)
    .post(`/api/pos/ventas/${saleId}/anular`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

function createSaleReq(token, cashSessionId) {
  return request(app)
    .post("/api/pos/ventas")
    .set("Authorization", `Bearer ${token}`)
    .send({ cashSessionId });
}

function addLineReq(token, saleId, body) {
  return request(app)
    .post(`/api/pos/ventas/${saleId}/lineas`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

function checkoutReq(token, saleId, payments) {
  return request(app)
    .post(`/api/pos/ventas/${saleId}/checkout`)
    .set("Authorization", `Bearer ${token}`)
    .send({ payments });
}

async function stockStatus(productId) {
  // Lectura directa por BD para las aserciones.
  const units = await prisma.stockUnit.groupBy({
    by: ["state"],
    where: { productId },
    _count: { _all: true },
  });
  if (units.length) {
    const byState = Object.fromEntries(units.map((u) => [u.state, u._count._all]));
    return {
      available: byState.DISPONIBLE ?? 0,
      reserved: byState.RESERVADA ?? 0,
      sold: byState.VENDIDA ?? 0,
    };
  }
  const level = await prisma.stockLevel.findFirst({ where: { productId } });
  return { available: level?.available ?? 0, reserved: level?.reserved ?? 0, sold: 0 };
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

describe("Bloque 3B — carrito ↔ motor de inventario (§11)", () => {
  // AC-3.01 — Agregar un single reserva exactamente esa unidad (RESERVADA).
  it("AC-3.01) agregar un single crea una reserva sobre la unidad", async () => {
    const { user, token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Black Lotus", precio: 1000 });
    await loadStock(token, single, 1);
    const sale = (await createSaleReq(token, (await openSession(user.id)).id)).body;

    const res = await addLineReq(token, sale.id, { productId: single });
    expect(res.status).toBe(201);
    expect(res.body.quantity).toBe(1);
    expect(res.body.trackingMode).toBe("UNIDAD");
    expect(res.body.stockUnitId).not.toBeNull();

    const reservation = await prisma.reservation.findUnique({
      where: { id: res.body.reservationId },
    });
    expect(reservation.state).toBe("ACTIVA");
    const unit = await prisma.stockUnit.findUnique({ where: { id: res.body.stockUnitId } });
    expect(unit.state).toBe("RESERVADA");

    const status = await stockStatus(single);
    expect(status).toMatchObject({ available: 0, reserved: 1 });
  });

  // AC-3.02 — Agregar un producto por cantidad reserva N; available baja en N.
  it("AC-3.02) agregar producto por cantidad reserva N del pool", async () => {
    const { user, token } = await admin();
    const sealed = await createProduct(token, { type: "SEALED", name: "Booster Box", precio: 90000 });
    await loadStock(token, sealed, 10);
    const sale = (await createSaleReq(token, (await openSession(user.id)).id)).body;

    const res = await addLineReq(token, sale.id, { productId: sealed, quantity: 4 });
    expect(res.status).toBe(201);
    expect(res.body.quantity).toBe(4);

    const status = await stockStatus(sealed);
    expect(status).toMatchObject({ available: 6, reserved: 4 });
  });

  // AC-3.03 — Quitar una línea libera su reserva y restituye el stock.
  it("AC-3.03) quitar una línea libera la reserva y devuelve el stock", async () => {
    const { user, token } = await admin();
    const sealed = await createProduct(token, { type: "SEALED", name: "Bundle", precio: 30000 });
    await loadStock(token, sealed, 5);
    const sale = (await createSaleReq(token, (await openSession(user.id)).id)).body;
    const line = (await addLineReq(token, sale.id, { productId: sealed, quantity: 2 })).body;

    const res = await request(app)
      .delete(`/api/pos/ventas/${sale.id}/lineas/${line.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const reservation = await prisma.reservation.findUnique({
      where: { id: line.reservationId },
    });
    expect(reservation.state).toBe("LIBERADA");
    expect(await prisma.saleLine.findUnique({ where: { id: line.id } })).toBeNull();
    const status = await stockStatus(sealed);
    expect(status).toMatchObject({ available: 5, reserved: 0 });
  });

  // AC-3.04 — Dos cajas reservando la misma unidad single: solo una gana.
  it("AC-3.04) dos terminales sobre la misma unidad → 1 ok, 1 conflicto", async () => {
    const { user, token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Time Walk", precio: 1000 });
    await loadStock(token, single, 1);
    const saleA = (await createSaleReq(token, (await openSession(user.id)).id)).body;
    const saleB = (await createSaleReq(token, (await openSession(user.id)).id)).body;

    const results = await Promise.allSettled([
      addLineReq(token, saleA.id, { productId: single }),
      addLineReq(token, saleB.id, { productId: single }),
    ]);
    const codes = results.map((r) => (r.status === "fulfilled" ? r.value.status : 500)).sort();
    expect(codes).toEqual([201, 409]);

    const status = await stockStatus(single);
    expect(status).toMatchObject({ available: 0, reserved: 1 });
  });

  // AC-3.05 — Un carrito sin checkout expira: reservas vuelven a DISPONIBLE y la
  // venta queda ABANDONADA.
  it("AC-3.05) carrito expirado → reservas liberadas y venta ABANDONADA", async () => {
    const { user, token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Timetwister", precio: 1000 });
    await loadStock(token, single, 1);
    const sale = (await createSaleReq(token, (await openSession(user.id)).id)).body;
    const line = (await addLineReq(token, sale.id, { productId: single })).body;

    // Vencer la reserva del carrito moviendo expiresAt al pasado.
    await prisma.reservation.update({
      where: { id: line.reservationId },
      data: { expiresAt: new Date(Date.now() - 60 * 1000) },
    });

    await expireReservations();
    const abandoned = await expireAbandonedSales();
    expect(abandoned).toBe(1);

    const reservation = await prisma.reservation.findUnique({
      where: { id: line.reservationId },
    });
    expect(reservation.state).toBe("EXPIRADA");
    const updated = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(updated.state).toBe("ABANDONADA");
    const status = await stockStatus(single);
    expect(status).toMatchObject({ available: 1, reserved: 0 });
  });

  // AC-3.11 — El precio de la línea no cambia si el producto cambia de precio
  // después de agregarla (snapshot).
  it("AC-3.11) el precio de la línea queda congelado al agregarla", async () => {
    const { user, token } = await admin();
    const sealed = await createProduct(token, { type: "SEALED", name: "Snack", precio: 1500 });
    await loadStock(token, sealed, 5);
    const sale = (await createSaleReq(token, (await openSession(user.id)).id)).body;
    const line = (await addLineReq(token, sale.id, { productId: sealed, quantity: 2 })).body;
    expect(line.unitPrice).toBe(1500);
    expect(line.lineTotal).toBe(3000);

    // Cambia el precio del producto después de agregar la línea.
    await prisma.product.update({ where: { id: sealed }, data: { precio: 9999 } });

    const persisted = await prisma.saleLine.findUnique({ where: { id: line.id } });
    expect(persisted.unitPrice).toBe(1500);
    expect(persisted.lineTotal).toBe(3000);
  });
});

describe("Bloque 3C — checkout y pagos (§11)", () => {
  // AC-3.06 — Checkout con Σ pagos = total confirma TODAS las reservas a VENDIDA.
  it("AC-3.06) checkout confirma todas las reservas en una transacción", async () => {
    const { user, token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Mox Ruby", precio: 1000 });
    const sealed = await createProduct(token, { type: "SEALED", name: "Box", precio: 5000 });
    await loadStock(token, single, 1);
    await loadStock(token, sealed, 5);
    const sale = (await createSaleReq(token, (await openSession(user.id)).id)).body;
    const l1 = (await addLineReq(token, sale.id, { productId: single })).body;
    const l2 = (await addLineReq(token, sale.id, { productId: sealed, quantity: 2 })).body;
    const total = l1.lineTotal + l2.lineTotal; // 1000 + 10000

    const res = await checkoutReq(token, sale.id, [{ method: "CASH", amount: total }]);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("COMPLETADA");
    expect(res.body.folio).toBeGreaterThan(0);

    for (const id of [l1.reservationId, l2.reservationId]) {
      const r = await prisma.reservation.findUnique({ where: { id } });
      expect(r.state).toBe("CONFIRMADA");
    }
    const single1 = await stockStatus(single);
    expect(single1.sold).toBe(1);
    const sealedStatus = await stockStatus(sealed);
    expect(sealedStatus.reserved).toBe(0);
    expect(sealedStatus.available).toBe(3);
  });

  // AC-3.07 — Si la confirmación de cualquier reserva falla, rollback total: no
  // se cobra y la venta sigue en BORRADOR.
  it("AC-3.07) una confirmación que falla hace rollback total", async () => {
    const { user, token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Sol Ring", precio: 1000 });
    await loadStock(token, single, 2);
    const sale = (await createSaleReq(token, (await openSession(user.id)).id)).body;
    const l1 = (await addLineReq(token, sale.id, { productId: single })).body;
    const l2 = (await addLineReq(token, sale.id, { productId: single })).body;

    // Vence (sin liberar) la reserva de la segunda línea: confirmTx la rechazará.
    await prisma.reservation.update({
      where: { id: l2.reservationId },
      data: { expiresAt: new Date(Date.now() - 60 * 1000) },
    });

    const res = await checkoutReq(token, sale.id, [{ method: "CASH", amount: 2000 }]);
    expect(res.status).toBe(409);

    const updated = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(updated.state).toBe("BORRADOR");
    expect(updated.folio).toBeNull();
    expect(await prisma.payment.count({ where: { saleId: sale.id } })).toBe(0);
    for (const id of [l1.reservationId, l2.reservationId]) {
      const r = await prisma.reservation.findUnique({ where: { id } });
      expect(r.state).toBe("ACTIVA"); // ninguna quedó CONFIRMADA
    }
    const status = await stockStatus(single);
    expect(status.sold).toBe(0);
    expect(status.reserved).toBe(2);
  });

  // AC-3.08 — Pago mixto: la suma debe igualar el total; si no, se rechaza.
  it("AC-3.08) pago mixto debe cuadrar con el total", async () => {
    const { user, token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Mana Crypt", precio: 1000 });
    await loadStock(token, single, 1);
    const sale = (await createSaleReq(token, (await openSession(user.id)).id)).body;
    await addLineReq(token, sale.id, { productId: single });

    // Suma que no cuadra → 400, la venta no se cierra.
    const bad = await checkoutReq(token, sale.id, [{ method: "CASH", amount: 900 }]);
    expect(bad.status).toBe(400);
    expect((await prisma.sale.findUnique({ where: { id: sale.id } })).state).toBe("BORRADOR");

    // Mixto que cuadra → 200 con dos pagos.
    const ok = await checkoutReq(token, sale.id, [
      { method: "CASH", amount: 600 },
      { method: "DEBIT", amount: 400 },
    ]);
    expect(ok.status).toBe(200);
    expect(await prisma.payment.count({ where: { saleId: sale.id } })).toBe(2);
  });

  // AC-3.09 — El exceso de efectivo es vuelto (no se persiste); el neto al cajón
  // es la suma de los pagos CASH (= el monto aplicado, no el recibido).
  it("AC-3.09) solo se persiste el monto aplicado, no el vuelto", async () => {
    const { user, token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Lotus Petal", precio: 1000 });
    await loadStock(token, single, 1);
    const sale = (await createSaleReq(token, (await openSession(user.id)).id)).body;
    await addLineReq(token, sale.id, { productId: single });

    // El cajero recibió $2000 pero aplica $1000; el vuelto vive en la UI.
    const res = await checkoutReq(token, sale.id, [{ method: "CASH", amount: 1000 }]);
    expect(res.status).toBe(200);
    const payments = await prisma.payment.findMany({ where: { saleId: sale.id } });
    expect(payments).toHaveLength(1);
    const netoCajon = payments.filter((p) => p.method === "CASH").reduce((s, p) => s + p.amount, 0);
    expect(netoCajon).toBe(1000);
  });

  // AC-3.10 — El folio es correlativo, único y sin huecos bajo concurrencia.
  it("AC-3.10) folios correlativos sin huecos en checkouts concurrentes", async () => {
    const { user, token } = await admin();
    const pA = await createProduct(token, { type: "SINGLE", name: "Carta A", precio: 1000 });
    const pB = await createProduct(token, { type: "SINGLE", name: "Carta B", precio: 1000 });
    await loadStock(token, pA, 1);
    await loadStock(token, pB, 1);
    const saleA = (await createSaleReq(token, (await openSession(user.id)).id)).body;
    const saleB = (await createSaleReq(token, (await openSession(user.id)).id)).body;
    await addLineReq(token, saleA.id, { productId: pA });
    await addLineReq(token, saleB.id, { productId: pB });

    const [rA, rB] = await Promise.all([
      checkoutReq(token, saleA.id, [{ method: "CASH", amount: 1000 }]),
      checkoutReq(token, saleB.id, [{ method: "CASH", amount: 1000 }]),
    ]);
    expect(rA.status).toBe(200);
    expect(rB.status).toBe(200);
    expect([rA.body.folio, rB.body.folio].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  // AC-3.21 — Todos los montos persistidos son CLP enteros.
  it("AC-3.21) montos persistidos enteros (CLP)", async () => {
    const { user, token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Jeweled Lotus", precio: 1000 });
    await loadStock(token, single, 1);
    const sale = (await createSaleReq(token, (await openSession(user.id)).id)).body;
    await addLineReq(token, sale.id, { productId: single });
    await checkoutReq(token, sale.id, [{ method: "CASH", amount: 1000 }]);

    const persisted = await prisma.sale.findUnique({
      where: { id: sale.id },
      include: { lines: true, payments: true },
    });
    for (const v of [persisted.subtotal, persisted.total, persisted.totalDiscount]) {
      expect(Number.isInteger(v)).toBe(true);
    }
    for (const l of persisted.lines) expect(Number.isInteger(l.unitPrice)).toBe(true);
    for (const p of persisted.payments) expect(Number.isInteger(p.amount)).toBe(true);
  });

  // STORE_CREDIT está reservado pero deshabilitado hasta el wallet (bloque 4).
  it("rechaza STORE_CREDIT como medio de pago (deshabilitado)", async () => {
    const { user, token } = await admin();
    const single = await createProduct(token, { type: "SINGLE", name: "Chrome Mox", precio: 1000 });
    await loadStock(token, single, 1);
    const sale = (await createSaleReq(token, (await openSession(user.id)).id)).body;
    await addLineReq(token, sale.id, { productId: single });

    const res = await checkoutReq(token, sale.id, [{ method: "STORE_CREDIT", amount: 1000 }]);
    expect(res.status).toBe(400);
    expect((await prisma.sale.findUnique({ where: { id: sale.id } })).state).toBe("BORRADOR");
  });
});

describe("Bloque 3D — caja, descuento y anulación (§11)", () => {
  // AC-3.12 — A lo sumo una SesionCaja ABIERTA por terminal.
  it("AC-3.12) no se abre una segunda caja en un terminal ya abierto", async () => {
    const { token } = await admin();
    const terminal = await createTerminal();

    const r1 = await openSessionReq(token, terminal.id, 10000);
    expect(r1.status).toBe(201);
    expect(r1.body.state).toBe("ABIERTA");

    const r2 = await openSessionReq(token, terminal.id, 5000);
    expect(r2.status).toBe(409);

    const open = await prisma.cashSession.count({
      where: { terminalId: terminal.id, state: "ABIERTA" },
    });
    expect(open).toBe(1);
  });

  // AC-3.13 — Cuadre: esperado = fondo + Σ CASH; diferencia = contado − esperado.
  it("AC-3.13) el cierre calcula esperado y diferencia", async () => {
    const { token } = await admin();
    const terminal = await createTerminal();
    const session = (await openSessionReq(token, terminal.id, 10000)).body;

    const single = await createProduct(token, { type: "SINGLE", name: "Ancestral", precio: 1000 });
    await loadStock(token, single, 1);
    const sale = (await createSaleReq(token, session.id)).body;
    await addLineReq(token, sale.id, { productId: single });
    await checkoutReq(token, sale.id, [{ method: "CASH", amount: 1000 }]);

    // Contar exactamente lo esperado (10000 + 1000) → diferencia 0, sin PIN.
    const close = await closeReq(token, session.id, 11000);
    expect(close.status).toBe(200);
    expect(close.body.expectedAmount).toBe(11000);
    expect(close.body.difference).toBe(0);
    expect(close.body.state).toBe("CERRADA");
  });

  // AC-3.14 — Cierre con diferencia sobre umbral exige revalidación PIN.
  it("AC-3.14) cierre con diferencia sobre umbral exige PIN", async () => {
    const { token } = await admin();
    const terminal = await createTerminal();
    const session = (await openSessionReq(token, terminal.id, 10000)).body;

    // Sin ventas: esperado 10000. Contar 10600 → diferencia 600 > umbral 500.
    const noPin = await closeReq(token, session.id, 10600);
    expect(noPin.status).toBe(403);
    expect((await prisma.cashSession.findUnique({ where: { id: session.id } })).state).toBe(
      "ABIERTA"
    );

    const withPin = await closeReq(token, session.id, 10600, "4321");
    expect(withPin.status).toBe(200);
    expect(withPin.body.difference).toBe(600);
  });

  // AC-3.15 — Anular una venta COMPLETADA revierte inventario (unidad/cantidad
  // → DISPONIBLE) con movimiento compensatorio.
  it("AC-3.15) anular revierte inventario y deja la venta ANULADA", async () => {
    const { token } = await admin();
    const terminal = await createTerminal();
    const session = (await openSessionReq(token, terminal.id, 0)).body;

    const single = await createProduct(token, { type: "SINGLE", name: "Mox Pearl", precio: 1000 });
    const sealed = await createProduct(token, { type: "SEALED", name: "Box", precio: 5000 });
    await loadStock(token, single, 1);
    await loadStock(token, sealed, 5);
    const sale = (await createSaleReq(token, session.id)).body;
    const l1 = (await addLineReq(token, sale.id, { productId: single })).body;
    const l2 = (await addLineReq(token, sale.id, { productId: sealed, quantity: 2 })).body;
    await checkoutReq(token, sale.id, [{ method: "CASH", amount: l1.lineTotal + l2.lineTotal }]);

    const res = await anularReq(token, sale.id, { pin: "4321", reason: "cliente se arrepintió" });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("ANULADA");

    // El stock vuelve a estar disponible.
    expect(await stockStatus(single)).toMatchObject({ available: 1, sold: 0 });
    expect((await stockStatus(sealed)).available).toBe(5);

    // Las reservas quedan ANULADA y hay un movimiento ANULACION por línea.
    for (const id of [l1.reservationId, l2.reservationId]) {
      expect((await prisma.reservation.findUnique({ where: { id } })).state).toBe("ANULADA");
    }
    expect(await prisma.stockMovement.count({ where: { type: "ANULACION" } })).toBe(2);
  });

  // AC-3.16 — Anular exige rol autorizado + PIN; queda auditada con usuario.
  it("AC-3.16) anular exige rol autorizado + PIN y queda auditada", async () => {
    const { user: adminUser, token } = await admin();
    const terminal = await createTerminal();
    const session = (await openSessionReq(token, terminal.id, 0)).body;
    const single = await createProduct(token, { type: "SINGLE", name: "Mox Jet", precio: 1000 });
    await loadStock(token, single, 1);
    const sale = (await createSaleReq(token, session.id)).body;
    await addLineReq(token, sale.id, { productId: single });
    await checkoutReq(token, sale.id, [{ method: "CASH", amount: 1000 }]);

    // Asistente: rol insuficiente → 403 (la venta sigue COMPLETADA).
    const { token: saToken } = await assistant();
    const byAssistant = await anularReq(saToken, sale.id, { pin: "4321" });
    expect(byAssistant.status).toBe(403);

    // Admin con PIN incorrecto → 403.
    const wrongPin = await anularReq(token, sale.id, { pin: "0000" });
    expect(wrongPin.status).toBe(403);
    expect((await prisma.sale.findUnique({ where: { id: sale.id } })).state).toBe("COMPLETADA");

    // Admin con PIN correcto → 200 y auditoría.
    const ok = await anularReq(token, sale.id, { pin: "4321", reason: "error de caja" });
    expect(ok.status).toBe(200);
    const log = await prisma.auditLog.findFirst({ where: { action: "anular_venta" } });
    expect(log).not.toBeNull();
    expect(log.userId).toBe(adminUser.id);
  });

  // AC-3.17 — Una venta de una sesión ya CERRADA no se anula por esta vía.
  it("AC-3.17) no se anula una venta de una caja ya cerrada", async () => {
    const { token } = await admin();
    const terminal = await createTerminal();
    const session = (await openSessionReq(token, terminal.id, 0)).body;
    const single = await createProduct(token, { type: "SINGLE", name: "Mox Emerald", precio: 1000 });
    await loadStock(token, single, 1);
    const sale = (await createSaleReq(token, session.id)).body;
    await addLineReq(token, sale.id, { productId: single });
    await checkoutReq(token, sale.id, [{ method: "CASH", amount: 1000 }]);

    // Cierre cuadrado (esperado = 0 + 1000), sin PIN.
    await closeReq(token, session.id, 1000);

    const res = await anularReq(token, sale.id, { pin: "4321" });
    expect(res.status).toBe(409);
    expect((await prisma.sale.findUnique({ where: { id: sale.id } })).state).toBe("COMPLETADA");
  });

  // AC-3.18 — El contador lee ventas/cajas pero no ejecuta ninguna mutación.
  it("AC-3.18) el contador lee pero no muta", async () => {
    const { token } = await admin();
    const terminal = await createTerminal();
    const session = (await openSessionReq(token, terminal.id, 0)).body;
    const single = await createProduct(token, { type: "SINGLE", name: "Mox Sapphire", precio: 1000 });
    await loadStock(token, single, 1);
    const sale = (await createSaleReq(token, session.id)).body;
    await addLineReq(token, sale.id, { productId: single });
    await checkoutReq(token, sale.id, [{ method: "CASH", amount: 1000 }]);

    const { token: accToken } = await accountant();
    const accAuth = { Authorization: `Bearer ${accToken}` };

    const detail = await request(app).get(`/api/pos/ventas/${sale.id}`).set(accAuth);
    expect(detail.status).toBe(200);
    const list = await request(app).get(`/api/pos/ventas`).set(accAuth);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);

    // No puede crear venta ni anular (matriz de roles).
    const create = await request(app)
      .post("/api/pos/ventas")
      .set(accAuth)
      .send({ cashSessionId: session.id });
    expect(create.status).toBe(403);
    const anular = await anularReq(accToken, sale.id, { pin: "4321" });
    expect(anular.status).toBe(403);
  });

  // AC-3.19 — Descuento sobre umbral por asistente exige PIN de supervisor y se
  // audita; bajo umbral lo aplica el asistente sin PIN.
  it("AC-3.19) descuento sobre umbral exige PIN de supervisor", async () => {
    const { user: adminUser, token: adminToken } = await admin();
    const terminal = await createTerminal();
    const session = (await openSessionReq(adminToken, terminal.id, 0)).body;
    const sealed = await createProduct(adminToken, { type: "SEALED", name: "Caja", precio: 10000 });
    await loadStock(adminToken, sealed, 5);

    const { token: saToken } = await assistant();
    const sale = (await createSaleReq(saToken, session.id)).body;
    const line = (await addLineReq(saToken, sale.id, { productId: sealed, quantity: 1 })).body;

    // Descuento 2000 sobre base 10000 = 20% > umbral 10% → sin PIN supervisor: 403.
    const noPin = await discountReq(saToken, sale.id, { lineId: line.id, lineDiscount: 2000 });
    expect(noPin.status).toBe(403);

    // Con supervisorId + PIN del admin → 200 y auditoría.
    const ok = await discountReq(saToken, sale.id, {
      lineId: line.id,
      lineDiscount: 2000,
      supervisorId: adminUser.id,
      pin: "4321",
    });
    expect(ok.status).toBe(200);
    const persisted = await prisma.saleLine.findUnique({ where: { id: line.id } });
    expect(persisted.lineDiscount).toBe(2000);
    expect(persisted.lineTotal).toBe(8000);
    const log = await prisma.auditLog.findFirst({ where: { action: "descuento_sobre_umbral" } });
    expect(log).not.toBeNull();

    // Bajo umbral (500 = 5%) lo aplica el asistente sin PIN.
    const under = await discountReq(saToken, sale.id, { lineId: line.id, lineDiscount: 500 });
    expect(under.status).toBe(200);
    expect((await prisma.saleLine.findUnique({ where: { id: line.id } })).lineDiscount).toBe(500);
  });

  // AC-3.20 — Toda operación de POS queda registrada en auditoría.
  it("AC-3.20) toda operación de POS queda auditada", async () => {
    const { token } = await admin();
    const terminal = await createTerminal();
    const session = (await openSessionReq(token, terminal.id, 1000)).body;

    // Un solo producto por cantidad con stock para dos reservas: minimiza los
    // round-trips contra la BD remota (la suite ya es lenta).
    const pack = await createProduct(token, { type: "SEALED", name: "Pack", precio: 1000 });
    await loadStock(token, pack, 3);

    const sale = (await createSaleReq(token, session.id)).body;
    const lineA = (await addLineReq(token, sale.id, { productId: pack, quantity: 1 })).body;
    const lineB = (await addLineReq(token, sale.id, { productId: pack, quantity: 1 })).body;

    // Quitar la línea B (libera su reserva) → quitar_linea.
    await request(app)
      .delete(`/api/pos/ventas/${sale.id}/lineas/${lineB.id}`)
      .set("Authorization", `Bearer ${token}`);

    // Descuento sobre umbral (200/1000 = 20%) por admin → descuento_sobre_umbral.
    await discountReq(token, sale.id, { lineId: lineA.id, lineDiscount: 200 });

    // Total = 1000 − 200 = 800.
    await checkoutReq(token, sale.id, [{ method: "CASH", amount: 800 }]);
    await request(app)
      .post(`/api/pos/sesiones/${session.id}/no-sale`)
      .set("Authorization", `Bearer ${token}`)
      .send({ pin: "4321" });
    await anularReq(token, sale.id, { pin: "4321", reason: "demo" });
    // Venta anulada: su CASH ya no cuadra. Esperado = fondo 1000 + 0.
    await closeReq(token, session.id, 1000);

    const actions = (await prisma.auditLog.findMany()).map((l) => l.action);
    for (const a of [
      "abrir_caja",
      "crear_venta",
      "agregar_linea",
      "quitar_linea",
      "descuento_sobre_umbral",
      "checkout",
      "no_sale",
      "anular_venta",
      "cerrar_caja",
    ]) {
      expect(actions).toContain(a);
    }
  });
});
