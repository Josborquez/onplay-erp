import { prisma } from "../db.js";
import { reserve, release, confirmTx, reverseTx } from "./inventory.js";
import { getSetting } from "./settings.js";
import { verifyPin } from "../lib/pin.js";
import { audit } from "./audit.js";
import { debitar, revertir } from "./wallet.js";

// Medios de pago habilitados. STORE_CREDIT debita el wallet del cliente de la
// venta dentro de la misma transacción del checkout (bloque 4B).
const PAYMENT_METHODS = ["CASH", "DEBIT", "CREDIT", "TRANSFER", "STORE_CREDIT"];

// Canal POS (bloque 3). El carrito de una venta es un conjunto de reservas
// vivas del bloque 2: agregar línea = reservar; quitar línea = liberar. El POS
// nunca escribe stock directo, todo pasa por el motor con su candado de fila.

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

// Carga una venta en BORRADOR (única editable). 404 si no existe, 409 si su
// estado ya no admite cambios de carrito.
async function loadDraftSale(saleId, tx = prisma) {
  const sale = await tx.sale.findUnique({ where: { id: Number(saleId) } });
  if (!sale) throw err(404, "venta inexistente");
  if (sale.state !== "BORRADOR") throw err(409, "la venta no está en borrador");
  return sale;
}

// Recalcula subtotal/total de la venta a partir de sus líneas. El descuento de
// total (totalDiscount) se mantiene; los descuentos llegan en 3D.
async function recomputeTotals(tx, saleId) {
  const lines = await tx.saleLine.findMany({ where: { saleId: Number(saleId) } });
  const subtotal = lines.reduce((acc, l) => acc + l.lineTotal, 0);
  const sale = await tx.sale.findUnique({ where: { id: Number(saleId) } });
  const total = subtotal - sale.totalDiscount;
  await tx.sale.update({
    where: { id: Number(saleId) },
    data: { subtotal, total },
  });
}

// Devuelve la venta con sus líneas y pagos (para respuestas/verificación).
export async function getSale(saleId) {
  const sale = await prisma.sale.findUnique({
    where: { id: Number(saleId) },
    include: { lines: true, payments: true },
  });
  if (!sale) throw err(404, "venta inexistente");
  return sale;
}

// Crea una venta BORRADOR sobre una sesión de caja ABIERTA. customerId es
// opcional: asocia la venta a un cliente (necesario para pagar con STORE_CREDIT).
export async function createSale(cashSessionId, { userId, customerId }) {
  const session = await prisma.cashSession.findUnique({
    where: { id: Number(cashSessionId) },
  });
  if (!session) throw err(404, "sesión de caja inexistente");
  if (session.state !== "ABIERTA") throw err(409, "la caja no está abierta");

  let custId = null;
  if (customerId != null) {
    const customer = await prisma.customer.findUnique({ where: { id: Number(customerId) } });
    if (!customer) throw err(404, "cliente inexistente");
    custId = customer.id;
  }

  const sale = await prisma.sale.create({
    data: { cashSessionId: session.id, userId, customerId: custId },
  });
  await audit("crear_venta", {
    userId,
    detail: JSON.stringify({ saleId: sale.id, cashSessionId: session.id, customerId: custId }),
  });
  return sale;
}

// Agrega una línea al carrito: reserva el stock (bloque 2) y congela el precio,
// sku y descripción del producto. Singles (UNIDAD): cantidad 1 y unidad física
// identificada. Resto (CANTIDAD): N del pool.
export async function addLine(saleId, { productId, quantity }, { userId }) {
  await loadDraftSale(saleId);

  const product = await prisma.product.findUnique({
    where: { id: Number(productId) },
    select: { id: true, trackingMode: true, sku: true, name: true, precio: true },
  });
  if (!product) throw err(404, "producto inexistente");
  if (product.precio == null) throw err(400, "el producto no tiene precio de venta");

  // Singles: una línea = una unidad física. El resto reserva la cantidad pedida.
  const qty = product.trackingMode === "UNIDAD" ? 1 : Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) throw err(400, "cantidad inválida");

  // Reserva bajo candado de fila; 409 si no hay stock suficiente.
  const reservation = await reserve(product.id, qty, { userId });

  // Para singles, la unidad concreta que quedó RESERVADA bajo esta reserva.
  let stockUnitId = null;
  if (product.trackingMode === "UNIDAD") {
    const unit = await prisma.stockUnit.findFirst({
      where: { reservationId: reservation.id },
      select: { id: true },
    });
    stockUnitId = unit ? unit.id : null;
  }

  const unitPrice = product.precio;
  const lineTotal = unitPrice * qty;

  const line = await prisma.$transaction(async (tx) => {
    const created = await tx.saleLine.create({
      data: {
        saleId: Number(saleId),
        reservationId: reservation.id,
        productId: product.id,
        stockUnitId,
        sku: product.sku,
        description: product.name,
        trackingMode: product.trackingMode,
        quantity: qty,
        unitPrice,
        lineTotal,
      },
    });
    await recomputeTotals(tx, saleId);
    return created;
  });

  await audit("agregar_linea", {
    userId,
    detail: JSON.stringify({ saleId: Number(saleId), lineId: line.id, productId: product.id, qty }),
  });
  return line;
}

// Quita una línea del carrito: libera su reserva (stock vuelve a DISPONIBLE) y
// borra la línea. Recalcula los totales.
export async function removeLine(saleId, lineId, { userId } = {}) {
  await loadDraftSale(saleId);
  const line = await prisma.saleLine.findUnique({ where: { id: Number(lineId) } });
  if (!line || line.saleId !== Number(saleId)) throw err(404, "línea inexistente");

  await release(line.reservationId);

  await prisma.$transaction(async (tx) => {
    await tx.saleLine.delete({ where: { id: line.id } });
    await recomputeTotals(tx, saleId);
  });

  await audit("quitar_linea", {
    userId,
    detail: JSON.stringify({ saleId: Number(saleId), lineId: line.id }),
  });
  return getSale(saleId);
}

// Valida la lista de pagos y devuelve la suma aplicada. Rechaza montos no
// enteros/positivos. STORE_CREDIT se debita dentro del checkout (4B).
function validatePayments(payments) {
  if (!Array.isArray(payments) || payments.length === 0) {
    throw err(400, "se requieren pagos");
  }
  let sum = 0;
  for (const p of payments) {
    if (!PAYMENT_METHODS.includes(p.method)) throw err(400, "método de pago inválido");
    const amount = Number(p.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw err(400, "monto de pago inválido");
    sum += amount;
  }
  return sum;
}

// Checkout: cobra y cierra la venta en UNA transacción atómica. Confirma todas
// las reservas → VENDIDA, registra los pagos y asigna el folio correlativo bajo
// candado. Si cualquier confirmación falla, rollback total: no cobra, no mueve
// stock, la venta sigue en BORRADOR (AC-3.06/3.07).
export async function checkout(saleId, { payments }, { userId }) {
  const paid = validatePayments(payments);

  const sale = await prisma.$transaction(
    async (tx) => {
      // Candado sobre la venta: evita doble checkout concurrente.
      const locked = await tx.$queryRawUnsafe(
        `SELECT id FROM Sale WHERE id = ? FOR UPDATE`,
        Number(saleId)
      );
      if (!locked.length) throw err(404, "venta inexistente");

      const sale = await tx.sale.findUnique({
        where: { id: Number(saleId) },
        include: { lines: true },
      });
      if (sale.state !== "BORRADOR") throw err(409, "la venta no está en borrador");
      if (sale.lines.length === 0) throw err(400, "la venta no tiene líneas");
      if (paid !== sale.total) throw err(400, "el pago no cuadra con el total");

      // Confirma cada reserva con el motor del bloque 2 dentro de esta misma tx.
      for (const line of sale.lines) {
        await confirmTx(tx, line.reservationId, { userId });
      }

      // Registra los pagos. El candado del wallet se toma DESPUÉS de confirmar
      // el inventario (orden inventario → wallet, evita deadlocks; §5.1). Cada
      // STORE_CREDIT debita el wallet del cliente dentro de esta misma tx: si el
      // saldo no alcanza, debitar lanza 422 y la venta entera hace rollback
      // (sin fallback silencioso; cierra V-001).
      for (const p of payments) {
        let walletMovementId = null;
        if (p.method === "STORE_CREDIT") {
          if (sale.customerId == null) throw err(400, "STORE_CREDIT requiere un cliente asociado");
          const mov = await debitar(
            {
              customerId: sale.customerId,
              monto: Number(p.amount),
              origen: "POS_VENTA",
              reference: `POS-DEBITO-${sale.id}`,
              saleId: sale.id,
              performedBy: userId,
            },
            tx
          );
          walletMovementId = mov.id;
        }
        await tx.payment.create({
          data: {
            saleId: sale.id,
            method: p.method,
            amount: Number(p.amount),
            reference: p.reference ?? null,
            walletMovementId,
          },
        });
      }

      // Folio correlativo sin huecos: el INSERT … ON DUPLICATE KEY UPDATE toma el
      // candado de la fila del contador; LAST_INSERT_ID es por conexión y la tx
      // usa una sola, así que el SELECT devuelve el valor recién asignado.
      await tx.$executeRawUnsafe(
        `INSERT INTO Counter (name, value) VALUES ('pos_folio', LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)`
      );
      const rows = await tx.$queryRawUnsafe(`SELECT LAST_INSERT_ID() AS folio`);
      const folio = Number(rows[0].folio);

      await tx.sale.update({
        where: { id: sale.id },
        data: { state: "COMPLETADA", folio, completedAt: new Date() },
      });

      return tx.sale.findUnique({
        where: { id: sale.id },
        include: { lines: true, payments: true },
      });
    },
    { timeout: 15000 }
  );

  await audit("checkout", {
    userId,
    detail: JSON.stringify({ saleId: sale.id, folio: sale.folio, total: sale.total }),
  });
  return sale;
}

// Marca como ABANDONADA toda venta BORRADOR cuyas reservas ya expiraron (el
// motor del bloque 2 las liberó por TTL). Se conserva para auditoría, no se
// borra. Lo invoca el timer de server.js tras expireReservations.
export async function expireAbandonedSales() {
  const drafts = await prisma.sale.findMany({
    where: { state: "BORRADOR" },
    include: { lines: { select: { reservationId: true } } },
  });

  let count = 0;
  for (const sale of drafts) {
    if (sale.lines.length === 0) continue; // carrito vacío: aún no expira
    const reservationIds = sale.lines.map((l) => l.reservationId);
    const active = await prisma.reservation.count({
      where: { id: { in: reservationIds }, state: "ACTIVA" },
    });
    if (active > 0) continue; // todavía hay reservas vivas
    await prisma.sale.update({
      where: { id: sale.id },
      data: { state: "ABANDONADA" },
    });
    count++;
  }
  return count;
}

// ───────────────────────────────────────────────────────────────────
// Bloque 3D — Caja, descuento y anulación.
// ───────────────────────────────────────────────────────────────────

// Revalida el PIN de un usuario (timing-safe vía bcrypt, bloque 1). 403 si falla.
async function requirePin(user, pin) {
  const ok = await verifyPin(pin ?? "", user.pinHash);
  if (!ok) throw err(403, "PIN inválido");
}

// Revalida el PIN de un SUPERVISOR (admin/super_admin activo) que autoriza una
// acción del asistente sobre el umbral. Devuelve el supervisor para auditarlo.
async function requireSupervisorPin(supervisorId, pin) {
  if (supervisorId == null) throw err(403, "se requiere PIN de supervisor");
  const sup = await prisma.user.findUnique({ where: { id: Number(supervisorId) } });
  if (!sup || !sup.isActive) throw err(403, "supervisor inválido");
  if (sup.role !== "STORE_ADMIN" && sup.role !== "SUPER_ADMIN") {
    throw err(403, "el supervisor no tiene autorización");
  }
  const ok = await verifyPin(pin ?? "", sup.pinHash);
  if (!ok) throw err(403, "PIN de supervisor inválido");
  return sup;
}

// Abre una sesión de caja sobre un terminal. Invariante (AC-3.12): a lo sumo una
// ABIERTA por terminal. Se garantiza con candado de fila sobre el Terminal, que
// serializa aperturas concurrentes del mismo punto de venta.
export async function openSession(terminalId, { openingFloat, userId }) {
  const float = Number(openingFloat);
  if (!Number.isInteger(float) || float < 0) throw err(400, "fondo de apertura inválido");

  const session = await prisma.$transaction(async (tx) => {
    const term = await tx.$queryRawUnsafe(
      `SELECT id, active FROM Terminal WHERE id = ? FOR UPDATE`,
      Number(terminalId)
    );
    if (!term.length) throw err(404, "terminal inexistente");
    if (!term[0].active) throw err(409, "terminal inactivo");

    const open = await tx.cashSession.findFirst({
      where: { terminalId: Number(terminalId), state: "ABIERTA" },
    });
    if (open) throw err(409, "el terminal ya tiene una caja abierta");

    return tx.cashSession.create({
      data: { terminalId: Number(terminalId), openedById: userId, openingFloat: float },
    });
  });

  await audit("abrir_caja", {
    userId,
    detail: JSON.stringify({ sessionId: session.id, terminalId: session.terminalId, openingFloat: float }),
  });
  return session;
}

// Sesión ABIERTA de un terminal (o null si no hay).
export async function getActiveSession(terminalId) {
  return prisma.cashSession.findFirst({
    where: { terminalId: Number(terminalId), state: "ABIERTA" },
  });
}

// Cierra la caja con cuadre (AC-3.13): esperado = fondo + Σ pagos CASH de las
// ventas COMPLETADAS de la sesión; diferencia = contado − esperado. Si |dif| >
// umbral exige PIN del cajero que cierra (AC-3.14).
export async function closeSession(sessionId, { countedAmount, pin }, { userId, user }) {
  const counted = Number(countedAmount);
  if (!Number.isInteger(counted) || counted < 0) throw err(400, "monto contado inválido");

  const session = await prisma.cashSession.findUnique({ where: { id: Number(sessionId) } });
  if (!session) throw err(404, "sesión inexistente");
  if (session.state !== "ABIERTA") throw err(409, "la caja no está abierta");

  // Solo cuentan los pagos CASH de ventas COMPLETADAS: una venta ANULADA
  // devolvió su efectivo, así que no incrementa el cajón.
  const cashAgg = await prisma.payment.aggregate({
    _sum: { amount: true },
    where: { method: "CASH", sale: { cashSessionId: session.id, state: "COMPLETADA" } },
  });
  const cashTotal = cashAgg._sum.amount ?? 0;
  const expectedAmount = session.openingFloat + cashTotal;
  const difference = counted - expectedAmount;

  const threshold = await getSetting("cash_diff_pin_threshold_clp");
  if (Math.abs(difference) > threshold) await requirePin(user, pin);

  const closed = await prisma.cashSession.update({
    where: { id: session.id },
    data: {
      state: "CERRADA",
      closedAt: new Date(),
      closedById: userId,
      expectedAmount,
      countedAmount: counted,
      difference,
    },
  });

  await audit("cerrar_caja", {
    userId,
    detail: JSON.stringify({ sessionId: session.id, expectedAmount, countedAmount: counted, difference }),
  });
  return closed;
}

// "No sale": abrir el cajón sin venta. Exige PIN y queda auditado (§5.6).
export async function noSale(sessionId, { pin }, { userId, user }) {
  const session = await prisma.cashSession.findUnique({ where: { id: Number(sessionId) } });
  if (!session) throw err(404, "sesión inexistente");
  if (session.state !== "ABIERTA") throw err(409, "la caja no está abierta");
  await requirePin(user, pin);
  await audit("no_sale", { userId, detail: JSON.stringify({ sessionId: session.id }) });
  return { ok: true };
}

// Aplica un descuento de línea (lineId) o de total (sin lineId) a una venta en
// BORRADOR. Bajo el umbral (% sobre la base) lo aplica el asistente; sobre el
// umbral exige rol admin o PIN de supervisor (AC-3.19) y se audita.
export async function applyDiscount(
  saleId,
  { lineId, lineDiscount, totalDiscount, pin, supervisorId },
  { user }
) {
  await loadDraftSale(saleId);
  const threshold = await getSetting("discount_pin_threshold_pct");
  const isAdmin = user.role === "STORE_ADMIN" || user.role === "SUPER_ADMIN";

  // Sobre el umbral: admin pasa directo; asistente necesita PIN de supervisor.
  async function authorize(pct, detail) {
    const overThreshold = pct > threshold;
    if (overThreshold && !isAdmin) {
      const sup = await requireSupervisorPin(supervisorId, pin);
      await audit("descuento_sobre_umbral", {
        userId: user.id,
        detail: JSON.stringify({ ...detail, pct, supervisorId: sup.id }),
      });
    } else if (overThreshold) {
      await audit("descuento_sobre_umbral", {
        userId: user.id,
        detail: JSON.stringify({ ...detail, pct, byAdmin: true }),
      });
    }
  }

  if (lineId != null) {
    const line = await prisma.saleLine.findUnique({ where: { id: Number(lineId) } });
    if (!line || line.saleId !== Number(saleId)) throw err(404, "línea inexistente");
    const disc = Number(lineDiscount);
    const base = line.unitPrice * line.quantity;
    if (!Number.isInteger(disc) || disc < 0 || disc > base) {
      throw err(400, "descuento de línea inválido");
    }
    const pct = base === 0 ? 0 : (disc / base) * 100;
    await authorize(pct, { saleId: Number(saleId), lineId: line.id });
    await prisma.$transaction(async (tx) => {
      await tx.saleLine.update({
        where: { id: line.id },
        data: { lineDiscount: disc, lineTotal: base - disc },
      });
      await recomputeTotals(tx, saleId);
    });
    return getSale(saleId);
  }

  if (totalDiscount != null) {
    const sale = await prisma.sale.findUnique({ where: { id: Number(saleId) } });
    const disc = Number(totalDiscount);
    if (!Number.isInteger(disc) || disc < 0 || disc > sale.subtotal) {
      throw err(400, "descuento de total inválido");
    }
    const pct = sale.subtotal === 0 ? 0 : (disc / sale.subtotal) * 100;
    await authorize(pct, { saleId: Number(saleId), totalDiscount: disc });
    await prisma.$transaction(async (tx) => {
      await tx.sale.update({ where: { id: Number(saleId) }, data: { totalDiscount: disc } });
      await recomputeTotals(tx, saleId);
    });
    return getSale(saleId);
  }

  throw err(400, "se requiere lineId o totalDiscount");
}

// Anula una venta COMPLETADA dentro de su sesión (AC-3.15/3.17). Revierte el
// inventario (Opción A, reverseTx) de cada línea bajo candado y deja la venta
// ANULADA. Los pagos quedan registrados pero ya no cuadran caja (la consulta de
// cierre solo suma CASH de ventas COMPLETADAS). Exige rol+PIN en la ruta.
export async function voidSale(saleId, { reason }, { userId }) {
  const voided = await prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRawUnsafe(
        `SELECT id FROM Sale WHERE id = ? FOR UPDATE`,
        Number(saleId)
      );
      if (!locked.length) throw err(404, "venta inexistente");

      const sale = await tx.sale.findUnique({
        where: { id: Number(saleId) },
        include: { lines: true, cashSession: true },
      });
      if (sale.state !== "COMPLETADA") throw err(409, "solo se anula una venta completada");
      if (sale.cashSession.state !== "ABIERTA") throw err(409, "la caja de la venta ya está cerrada");

      for (const line of sale.lines) {
        await reverseTx(tx, line.reservationId, { userId });
      }

      // Wallet (4B): si la venta se pagó con STORE_CREDIT, devuelve el saldo
      // dentro de esta misma tx. Idempotente por reference REVERSA-{saleId}:
      // re-anular no duplica el reembolso. null si no usó store credit.
      await revertir({ saleId: sale.id, performedBy: userId }, tx);

      return tx.sale.update({
        where: { id: sale.id },
        data: {
          state: "ANULADA",
          voidedAt: new Date(),
          voidedById: userId,
          voidReason: reason ?? null,
        },
        include: { lines: true, payments: true },
      });
    },
    { timeout: 15000 }
  );

  await audit("anular_venta", {
    userId,
    detail: JSON.stringify({ saleId: voided.id, folio: voided.folio, reason: reason ?? null }),
  });
  return voided;
}

// Listado de ventas con filtros opcionales (lectura; el contador puede usarlo).
export async function listSales({ cashSessionId, state } = {}) {
  const where = {};
  if (cashSessionId != null) where.cashSessionId = Number(cashSessionId);
  if (state) where.state = state;
  return prisma.sale.findMany({
    where,
    orderBy: { id: "desc" },
    include: { payments: true },
  });
}
