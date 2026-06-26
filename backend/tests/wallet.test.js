import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { resetDb, loginAs, createUser } from "./helpers.js";
import { createCustomer } from "../src/services/customers.js";
import { creditar, debitar, ajustar, saldoDe, revertir } from "../src/services/wallet.js";

const app = createApp();

// Operadores con distinto rol. PIN por defecto de createUser = "4321".
async function admin() {
  return loginAs(app, request, { email: `admin-${Date.now()}-${Math.random()}@onplay.cl`, role: "STORE_ADMIN" });
}
async function assistant() {
  return loginAs(app, request, { email: `asis-${Date.now()}-${Math.random()}@onplay.cl`, role: "SALES_ASSISTANT" });
}
async function accountant() {
  return loginAs(app, request, { email: `cont-${Date.now()}-${Math.random()}@onplay.cl`, role: "ACCOUNTANT" });
}

function createCustomerReq(token, body) {
  return request(app).post("/api/customers").set("Authorization", `Bearer ${token}`).send(body);
}
function creditarReq(token, id, body) {
  return request(app).post(`/api/wallet/${id}/creditar`).set("Authorization", `Bearer ${token}`).send(body);
}
function ajustarReq(token, id, body) {
  return request(app).post(`/api/wallet/${id}/ajustar`).set("Authorization", `Bearer ${token}`).send(body);
}
function saldoReq(token, id) {
  return request(app).get(`/api/wallet/${id}`).set("Authorization", `Bearer ${token}`);
}

// Crea un usuario suelto (para `performedBy` en pruebas a nivel de servicio).
async function someUser() {
  return createUser({ email: `u-${Date.now()}-${Math.random()}@onplay.cl` });
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

describe("Bloque 4A — motor de wallet (§10)", () => {
  // AC-4.01
  it("AC-4.01) crea cliente con nombre+teléfono; rut/email duplicado → 409", async () => {
    const { token } = await admin();

    const ok = await createCustomerReq(token, { nombre: "Cliente Mostrador", telefono: "+56911112222" });
    expect(ok.status).toBe(201);
    expect(ok.body.wallet.saldo).toBe(0);

    await createCustomerReq(token, { nombre: "Con RUT", rut: "11.111.111-1" }).expect(201);
    const dupRut = await createCustomerReq(token, { nombre: "Otro", rut: "11.111.111-1" });
    expect(dupRut.status).toBe(409);

    await createCustomerReq(token, { nombre: "Con Email", email: "dup@cli.cl" }).expect(201);
    const dupEmail = await createCustomerReq(token, { nombre: "Otro2", email: "dup@cli.cl" });
    expect(dupEmail.status).toBe(409);
  });

  // AC-4.02
  it("AC-4.02) creditar sube el saldo y crea el movimiento con saldoAntes/Despues", async () => {
    const { token, user } = await admin();
    const c = (await createCustomerReq(token, { nombre: "Recarga" })).body;

    const res = await creditarReq(token, c.id, { monto: 5000, reference: "REC-1", pin: "4321" });
    expect(res.status).toBe(201);
    expect(res.body.saldoAntes).toBe(0);
    expect(res.body.saldoDespues).toBe(5000);
    expect(res.body.reference).toBe("REC-1");
    expect(res.body.tipo).toBe("CREDITO_MANUAL");
    expect(res.body.performedBy).toBe(user.id);

    expect((await saldoReq(token, c.id)).body.saldo).toBe(5000);
  });

  // AC-4.03
  it("AC-4.03) reference repetida → 409 y el saldo no cambia (idempotencia)", async () => {
    const { token } = await admin();
    const c = (await createCustomerReq(token, { nombre: "Idem" })).body;

    await creditarReq(token, c.id, { monto: 1000, reference: "R1", pin: "4321" }).expect(201);
    const again = await creditarReq(token, c.id, { monto: 2000, reference: "R1", pin: "4321" });
    expect(again.status).toBe(409);
    expect((await saldoReq(token, c.id)).body.saldo).toBe(1000);

    // débito (servicio): misma reference no duplica.
    const u = await someUser();
    await debitar({ customerId: c.id, monto: 400, reference: "D1", performedBy: u.id });
    await expect(
      debitar({ customerId: c.id, monto: 400, reference: "D1", performedBy: u.id })
    ).rejects.toMatchObject({ status: 409 });
    expect(await saldoDe(c.id)).toBe(600);
  });

  // AC-4.04
  it("AC-4.04) dos débitos concurrentes: uno gana, el otro 422; saldo nunca negativo", async () => {
    const c = await createCustomer({ nombre: "Race" });
    const u = await someUser();
    await creditar({ customerId: c.id, monto: 1000, reference: `seed-${c.id}`, performedBy: u.id });

    const results = await Promise.allSettled([
      debitar({ customerId: c.id, monto: 1000, reference: `d1-${c.id}`, performedBy: u.id }),
      debitar({ customerId: c.id, monto: 1000, reference: `d2-${c.id}`, performedBy: u.id }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const ko = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(ko.length).toBe(1);
    expect(ko[0].reason.status).toBe(422);
    expect(await saldoDe(c.id)).toBe(0);
  });

  // AC-4.05
  it("AC-4.05) debitar con monto > saldo → 422, saldo intacto, sin movimiento", async () => {
    const c = await createCustomer({ nombre: "Low" });
    const u = await someUser();
    await creditar({ customerId: c.id, monto: 500, reference: `s-${c.id}`, performedBy: u.id });

    await expect(
      debitar({ customerId: c.id, monto: 1000, reference: `d-${c.id}`, performedBy: u.id })
    ).rejects.toMatchObject({ status: 422 });
    expect(await saldoDe(c.id)).toBe(500);
    expect(await prisma.walletMovement.count({ where: { customerId: c.id, tipo: "DEBITO_VENTA" } })).toBe(0);
  });

  // AC-4.06
  it("AC-4.06) ajuste negativo que dejaría saldo < 0 → rechazado", async () => {
    const { token } = await admin();
    const c = (await createCustomerReq(token, { nombre: "Ajuste" })).body;
    await creditarReq(token, c.id, { monto: 500, reference: "A-seed", pin: "4321" }).expect(201);

    const res = await ajustarReq(token, c.id, {
      monto: 1000,
      signo: "-",
      motivo: "corrección",
      reference: "A-neg",
      pin: "4321",
    });
    expect(res.status).toBe(422);
    expect((await saldoReq(token, c.id)).body.saldo).toBe(500);
  });

  // AC-4.10
  it("AC-4.10) invariante: saldo == suma firmada del ledger y >= 0", async () => {
    const c = await createCustomer({ nombre: "Inv" });
    const u = await someUser();
    await creditar({ customerId: c.id, monto: 1000, reference: `a-${c.id}`, performedBy: u.id });
    await creditar({ customerId: c.id, monto: 500, reference: `b-${c.id}`, performedBy: u.id });
    await ajustar({ customerId: c.id, monto: 300, signo: "-", motivo: "corr", reference: `c-${c.id}`, performedBy: u.id });
    await debitar({ customerId: c.id, monto: 200, reference: `d-${c.id}`, performedBy: u.id });

    const movs = await prisma.walletMovement.findMany({ where: { customerId: c.id }, orderBy: { id: "asc" } });
    let sum = 0;
    for (const m of movs) {
      const delta = m.saldoDespues - m.saldoAntes;
      expect(Math.abs(delta)).toBe(m.monto); // la magnitud del delta == monto
      sum += delta;
    }
    const saldo = await saldoDe(c.id);
    expect(sum).toBe(saldo);
    expect(saldo).toBeGreaterThanOrEqual(0);
    expect(saldo).toBe(1000); // 1000 + 500 − 300 − 200
  });

  // AC-4.13
  it("AC-4.13) asistente no puede ajustar (403); contador no puede creditar (403)", async () => {
    const { token: adminToken } = await admin();
    const c = (await createCustomerReq(adminToken, { nombre: "Roles" })).body;

    const { token: asisToken } = await assistant();
    const ajuste = await ajustarReq(asisToken, c.id, {
      monto: 100,
      signo: "+",
      motivo: "x",
      reference: "X-1",
      pin: "4321",
    });
    expect(ajuste.status).toBe(403);

    const { token: contToken } = await accountant();
    const credito = await creditarReq(contToken, c.id, { monto: 100, reference: "X-2", pin: "4321" });
    expect(credito.status).toBe(403);
  });

  // AC-4.14
  it("AC-4.14) acreditación sobre umbral exige PIN de supervisor", async () => {
    const { token: asisToken } = await assistant();
    const sup = await admin(); // supervisor admin (PIN 4321)
    const c = (await createCustomerReq(asisToken, { nombre: "Umbral" })).body;

    // umbral default 50.000: 60.000 sin supervisor → 403.
    const sinSup = await creditarReq(asisToken, c.id, { monto: 60000, reference: "U-1", pin: "4321" });
    expect(sinSup.status).toBe(403);
    expect((await saldoReq(asisToken, c.id)).body.saldo).toBe(0);

    // con PIN de supervisor → 201.
    const conSup = await creditarReq(asisToken, c.id, {
      monto: 60000,
      reference: "U-2",
      pin: "4321",
      supervisorId: sup.user.id,
      supervisorPin: "4321",
    });
    expect(conSup.status).toBe(201);
    expect((await saldoReq(asisToken, c.id)).body.saldo).toBe(60000);
  });

  // AC-4.15
  it("AC-4.15) toda mutación deja AuditLog con el performedBy de la sesión", async () => {
    const { token, user } = await admin();
    const c = (await createCustomerReq(token, { nombre: "Audit" })).body;
    await creditarReq(token, c.id, { monto: 1000, reference: "AU-1", pin: "4321" }).expect(201);

    const log = await prisma.auditLog.findFirst({
      where: { action: "wallet_creditar", userId: user.id },
      orderBy: { id: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log.detail).toContain("AU-1");
  });
});

// ─── Bloque 4B — integración POS (§5/§10) ──────────────────────────────
// El checkout del POS estrena el wallet como medio de pago real.

function createProductReq(token, body) {
  return request(app).post("/api/products").set("Authorization", `Bearer ${token}`).send(body);
}
async function createProduct(token, body) {
  const res = await createProductReq(token, body);
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
// Abre una caja ABIERTA directo en BD (no se ejercita el endpoint aquí).
async function openSession(userId) {
  const terminal = await prisma.terminal.create({ data: { name: `T-${Date.now()}-${Math.random()}` } });
  return prisma.cashSession.create({
    data: { terminalId: terminal.id, openedById: userId, openingFloat: 0 },
  });
}
function createSaleReq(token, cashSessionId, customerId) {
  return request(app)
    .post("/api/pos/ventas")
    .set("Authorization", `Bearer ${token}`)
    .send({ cashSessionId, customerId });
}
function addLineReq(token, saleId, body) {
  return request(app).post(`/api/pos/ventas/${saleId}/lineas`).set("Authorization", `Bearer ${token}`).send(body);
}
function checkoutReq(token, saleId, payments) {
  return request(app).post(`/api/pos/ventas/${saleId}/checkout`).set("Authorization", `Bearer ${token}`).send({ payments });
}
function anularReq(token, saleId, body) {
  return request(app).post(`/api/pos/ventas/${saleId}/anular`).set("Authorization", `Bearer ${token}`).send(body);
}

// Monta una venta COMPLETADA de un único single (precio dado) pagada como se
// indique. Devuelve { saleId, customerId, single }.
async function ventaSingle(token, user, { precio, credito, customerId, payments }) {
  const single = await createProduct(token, { type: "SINGLE", name: `S-${Math.random()}`, precio });
  await loadStock(token, single, 1);
  if (credito != null) {
    await creditar({ customerId, monto: credito, reference: `seed-${customerId}`, performedBy: user.id });
  }
  const session = await openSession(user.id);
  const sale = (await createSaleReq(token, session.id, customerId)).body;
  await addLineReq(token, sale.id, { productId: single });
  const res = await checkoutReq(token, sale.id, payments);
  return { res, saleId: sale.id, single };
}

describe("Bloque 4B — integración POS (§5)", () => {
  // AC-4.07
  it("AC-4.07) checkout con STORE_CREDIT suficiente: debita, crea DEBITO_VENTA y Payment.walletMovementId apunta a él", async () => {
    const { token, user } = await admin();
    const c = await createCustomer({ nombre: "SC" });
    const { res, saleId } = await ventaSingle(token, user, {
      precio: 1000,
      credito: 5000,
      customerId: c.id,
      payments: [{ method: "STORE_CREDIT", amount: 1000 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("COMPLETADA");

    expect(await saldoDe(c.id)).toBe(4000);

    const mov = await prisma.walletMovement.findUnique({ where: { reference: `POS-DEBITO-${saleId}` } });
    expect(mov.tipo).toBe("DEBITO_VENTA");
    expect(mov.monto).toBe(1000);
    expect(mov.saleId).toBe(saleId);

    const pay = await prisma.payment.findFirst({ where: { saleId, method: "STORE_CREDIT" } });
    expect(pay.walletMovementId).toBe(mov.id);
  });

  // AC-4.08
  it("AC-4.08) pago mixto STORE_CREDIT + efectivo: debita solo la parte de store credit", async () => {
    const { token, user } = await admin();
    const c = await createCustomer({ nombre: "Mix" });
    const { res, saleId } = await ventaSingle(token, user, {
      precio: 1000,
      credito: 600,
      customerId: c.id,
      payments: [
        { method: "STORE_CREDIT", amount: 600 },
        { method: "CASH", amount: 400 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await saldoDe(c.id)).toBe(0);

    const pays = await prisma.payment.findMany({ where: { saleId } });
    expect(pays).toHaveLength(2);
    const sc = pays.find((p) => p.method === "STORE_CREDIT");
    const cash = pays.find((p) => p.method === "CASH");
    expect(sc.walletMovementId).not.toBeNull();
    expect(cash.walletMovementId).toBeNull();
  });

  // AC-4.09
  it("AC-4.09) STORE_CREDIT > saldo: la venta entera hace rollback (sin venta, sin stock, sin movimiento)", async () => {
    const { token, user } = await admin();
    const c = await createCustomer({ nombre: "Insuf" });
    const { res, saleId, single } = await ventaSingle(token, user, {
      precio: 1000,
      credito: 500,
      customerId: c.id,
      payments: [{ method: "STORE_CREDIT", amount: 1000 }],
    });
    expect(res.status).toBe(422);

    expect((await prisma.sale.findUnique({ where: { id: saleId } })).state).toBe("BORRADOR");
    expect(await prisma.payment.count({ where: { saleId } })).toBe(0);
    expect(await prisma.walletMovement.count({ where: { saleId, tipo: "DEBITO_VENTA" } })).toBe(0);
    expect(await saldoDe(c.id)).toBe(500);
    // El single sigue reservado, no vendido.
    const unit = await prisma.stockUnit.findFirst({ where: { productId: single } });
    expect(unit.state).toBe("RESERVADA");
  });

  // AC-4.10 (sobre POS) — invariante tras un débito de venta real.
  it("AC-4.10b) invariante saldo == suma del ledger tras un débito POS", async () => {
    const { token, user } = await admin();
    const c = await createCustomer({ nombre: "InvPOS" });
    await ventaSingle(token, user, {
      precio: 1000,
      credito: 3000,
      customerId: c.id,
      payments: [{ method: "STORE_CREDIT", amount: 1000 }],
    });
    const movs = await prisma.walletMovement.findMany({ where: { customerId: c.id } });
    const sum = movs.reduce((s, m) => s + (m.saldoDespues - m.saldoAntes), 0);
    const saldo = await saldoDe(c.id);
    expect(sum).toBe(saldo);
    expect(saldo).toBe(2000);
  });

  // AC-4.11
  it("AC-4.11) anular una venta pagada con STORE_CREDIT crea REVERSA_VENTA y restaura el saldo", async () => {
    const { token, user } = await admin();
    const c = await createCustomer({ nombre: "Rev" });
    const { res, saleId } = await ventaSingle(token, user, {
      precio: 1000,
      credito: 1000,
      customerId: c.id,
      payments: [{ method: "STORE_CREDIT", amount: 1000 }],
    });
    expect(res.status).toBe(200);
    expect(await saldoDe(c.id)).toBe(0);

    const anul = await anularReq(token, saleId, { pin: "4321", reason: "test" });
    expect(anul.status).toBe(200);
    expect(anul.body.state).toBe("ANULADA");

    expect(await saldoDe(c.id)).toBe(1000);
    const rev = await prisma.walletMovement.findUnique({ where: { reference: `REVERSA-${saleId}` } });
    expect(rev.tipo).toBe("REVERSA_VENTA");
    expect(rev.monto).toBe(1000);
  });

  // AC-4.12
  it("AC-4.12) re-revertir no duplica el reembolso (idempotencia por REVERSA-{saleId})", async () => {
    const { token, user } = await admin();
    const c = await createCustomer({ nombre: "Idem2" });
    const { saleId } = await ventaSingle(token, user, {
      precio: 1000,
      credito: 1000,
      customerId: c.id,
      payments: [{ method: "STORE_CREDIT", amount: 1000 }],
    });
    await anularReq(token, saleId, { pin: "4321" }).then((r) => expect(r.status).toBe(200));
    expect(await saldoDe(c.id)).toBe(1000);

    // Volver a anular por el endpoint: la venta ya está ANULADA → 409.
    const again = await anularReq(token, saleId, { pin: "4321" });
    expect(again.status).toBe(409);

    // Y a nivel servicio, revertir es idempotente: devuelve el mismo movimiento,
    // sin crear otro y sin tocar el saldo.
    const existing = await prisma.walletMovement.findUnique({ where: { reference: `REVERSA-${saleId}` } });
    const reRun = await revertir({ saleId, performedBy: user.id });
    expect(reRun.id).toBe(existing.id);
    expect(await prisma.walletMovement.count({ where: { reference: `REVERSA-${saleId}` } })).toBe(1);
    expect(await saldoDe(c.id)).toBe(1000);
  });
});
