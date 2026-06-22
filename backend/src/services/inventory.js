import { prisma } from "../db.js";
import { getSetting } from "./settings.js";

// Motor de inventario (bloque 2B). Dos modos de rastreo derivados del producto
// (§2.2): UNIDAD = una fila StockUnit por carta (singles); CANTIDAD = contadores
// en StockLevel (sellado/snack/accesorio). El contrato reservar → (confirmar |
// liberar) corre bajo candado de fila (SELECT … FOR UPDATE) para evitar
// sobreventa (CLAUDE.md B3/B6).

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

// Valida que `quantity` sea un entero positivo.
function requireQuantity(quantity) {
  const q = Number(quantity);
  if (!Number.isInteger(q) || q <= 0) {
    throw err(400, "cantidad inválida");
  }
  return q;
}

// Resuelve la ubicación de la operación. Si no se pasa una, get-or-create de la
// tienda por defecto (2B opera solo sobre `tienda`).
async function resolveLocation(locationId, tx = prisma) {
  if (locationId != null) return Number(locationId);
  const loc = await tx.location.upsert({
    where: { name: "tienda" },
    update: {},
    create: { name: "tienda", isDefault: true },
  });
  return loc.id;
}

// Carga un producto y verifica que exista (404). Devuelve {id, trackingMode}.
async function loadProduct(productId, tx = prisma) {
  const product = await tx.product.findUnique({
    where: { id: Number(productId) },
    select: { id: true, trackingMode: true },
  });
  if (!product) throw err(404, "producto inexistente");
  return product;
}

// ENTRADA de stock (carga) dentro de una transacción dada. UNIDAD: crea N
// unidades DISPONIBLE. CANTIDAD: suma a `available`. Registra el movimiento
// físico. Reutilizable por el import ManaBox (2C), que carga muchas filas en
// una sola transacción.
export async function addStockTx(tx, productId, quantity, { locationId, userId } = {}) {
  const q = requireQuantity(quantity);
  const product = await loadProduct(productId, tx);
  const locId = await resolveLocation(locationId, tx);

  if (product.trackingMode === "UNIDAD") {
    await tx.stockUnit.createMany({
      data: Array.from({ length: q }, () => ({
        productId: product.id,
        locationId: locId,
        state: "DISPONIBLE",
      })),
    });
  } else {
    await tx.stockLevel.upsert({
      where: { productId_locationId: { productId: product.id, locationId: locId } },
      update: { available: { increment: q } },
      create: { productId: product.id, locationId: locId, available: q },
    });
  }

  await tx.stockMovement.create({
    data: {
      productId: product.id,
      locationId: locId,
      type: "ENTRADA",
      quantity: q,
      userId: userId ?? null,
    },
  });

  return getStockStatus(product.id, { locationId: locId }, tx);
}

// ENTRADA de stock (carga) como operación atómica propia.
export async function addStock(productId, quantity, opts = {}) {
  return prisma.$transaction((tx) => addStockTx(tx, productId, quantity, opts));
}

// Reserva `quantity` unidades bajo candado de fila. Rechaza con 409 si no hay
// stock suficiente. Crea la Reservation ACTIVA con expiresAt = now + TTL.
export async function reserve(productId, quantity, { locationId, userId } = {}) {
  const q = requireQuantity(quantity);
  const ttlMinutes = await getSetting("reservation_ttl_minutes");

  return prisma.$transaction(async (tx) => {
    const product = await loadProduct(productId, tx);
    const locId = await resolveLocation(locationId, tx);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    const reservation = await tx.reservation.create({
      data: {
        productId: product.id,
        locationId: locId,
        quantity: q,
        state: "ACTIVA",
        expiresAt,
        createdById: userId ?? null,
      },
    });

    if (product.trackingMode === "UNIDAD") {
      // Bloquea las primeras `q` unidades DISPONIBLE (current read FOR UPDATE).
      const rows = await tx.$queryRawUnsafe(
        `SELECT id FROM StockUnit WHERE productId = ? AND locationId = ? AND state = 'DISPONIBLE' ORDER BY id LIMIT ${q} FOR UPDATE`,
        product.id,
        locId
      );
      if (rows.length < q) throw err(409, "stock insuficiente");
      const ids = rows.map((r) => Number(r.id));
      await tx.stockUnit.updateMany({
        where: { id: { in: ids } },
        data: { state: "RESERVADA", reservationId: reservation.id },
      });
    } else {
      const rows = await tx.$queryRawUnsafe(
        `SELECT id, available FROM StockLevel WHERE productId = ? AND locationId = ? FOR UPDATE`,
        product.id,
        locId
      );
      const available = rows.length ? Number(rows[0].available) : 0;
      if (available < q) throw err(409, "stock insuficiente");
      await tx.stockLevel.update({
        where: { id: Number(rows[0].id) },
        data: { available: { decrement: q }, reserved: { increment: q } },
      });
    }

    return reservation;
  });
}

// Carga una reserva con candado de fila y verifica que esté en estado ACTIVA.
async function lockActiveReservation(tx, reservationId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id FROM Reservation WHERE id = ? FOR UPDATE`,
    Number(reservationId)
  );
  if (!rows.length) throw err(404, "reserva inexistente");
  const reservation = await tx.reservation.findUnique({
    where: { id: Number(reservationId) },
  });
  if (reservation.state !== "ACTIVA") throw err(409, "reserva no activa");
  return reservation;
}

// Confirma una reserva (venta). UNIDAD: unidades RESERVADA → VENDIDA. CANTIDAD:
// reserved -= q. Reservation → CONFIRMADA. Registra la SALIDA física.
export async function confirm(reservationId, { userId } = {}) {
  return prisma.$transaction(async (tx) => {
    const reservation = await lockActiveReservation(tx, reservationId);
    if (reservation.expiresAt < new Date()) throw err(409, "reserva vencida");

    const product = await loadProduct(reservation.productId, tx);
    if (product.trackingMode === "UNIDAD") {
      await tx.stockUnit.updateMany({
        where: { reservationId: reservation.id, state: "RESERVADA" },
        data: { state: "VENDIDA" },
      });
    } else {
      await tx.stockLevel.update({
        where: {
          productId_locationId: {
            productId: reservation.productId,
            locationId: reservation.locationId,
          },
        },
        data: { reserved: { decrement: reservation.quantity } },
      });
    }

    await tx.reservation.update({
      where: { id: reservation.id },
      data: { state: "CONFIRMADA" },
    });

    await tx.stockMovement.create({
      data: {
        productId: reservation.productId,
        locationId: reservation.locationId,
        type: "SALIDA",
        quantity: reservation.quantity,
        userId: userId ?? null,
      },
    });

    return tx.reservation.findUnique({ where: { id: reservation.id } });
  });
}

// Lógica común de liberación de una reserva ACTIVA: el stock vuelve a estar
// disponible y la reserva pasa a `targetState` (LIBERADA o EXPIRADA).
async function releaseReservation(tx, reservation, targetState) {
  const product = await loadProduct(reservation.productId, tx);
  if (product.trackingMode === "UNIDAD") {
    await tx.stockUnit.updateMany({
      where: { reservationId: reservation.id, state: "RESERVADA" },
      data: { state: "DISPONIBLE", reservationId: null },
    });
  } else {
    await tx.stockLevel.update({
      where: {
        productId_locationId: {
          productId: reservation.productId,
          locationId: reservation.locationId,
        },
      },
      data: {
        reserved: { decrement: reservation.quantity },
        available: { increment: reservation.quantity },
      },
    });
  }
  await tx.reservation.update({
    where: { id: reservation.id },
    data: { state: targetState },
  });
}

// Libera una reserva activa (cancelación). Stock → DISPONIBLE/available;
// Reservation → LIBERADA. No genera movimiento físico.
export async function release(reservationId) {
  return prisma.$transaction(async (tx) => {
    const reservation = await lockActiveReservation(tx, reservationId);
    await releaseReservation(tx, reservation, "LIBERADA");
    return tx.reservation.findUnique({ where: { id: reservation.id } });
  });
}

// Libera automáticamente las reservas ACTIVAS ya vencidas. Devuelve el nº de
// reservas liberadas. Lo invoca el timer de server.js (cada 60s).
export async function expireReservations(now = new Date()) {
  const expired = await prisma.reservation.findMany({
    where: { state: "ACTIVA", expiresAt: { lt: now } },
    select: { id: true },
  });
  let count = 0;
  for (const { id } of expired) {
    try {
      await prisma.$transaction(async (tx) => {
        const reservation = await lockActiveReservation(tx, id);
        await releaseReservation(tx, reservation, "EXPIRADA");
      });
      count++;
    } catch (e) {
      // Si otra transacción ya la confirmó/liberó entre la búsqueda y el lock,
      // dejará de estar ACTIVA y lockActiveReservation lanzará 409: se ignora.
      if (!e.status) throw e;
    }
  }
  return count;
}

// Estado de stock de un producto (para verificación/tests).
export async function getStockStatus(productId, { locationId } = {}, tx = prisma) {
  const product = await loadProduct(productId, tx);
  const locId = await resolveLocation(locationId, tx);

  if (product.trackingMode === "UNIDAD") {
    const grouped = await tx.stockUnit.groupBy({
      by: ["state"],
      where: { productId: product.id, locationId: locId },
      _count: { _all: true },
    });
    const byState = Object.fromEntries(grouped.map((g) => [g.state, g._count._all]));
    return {
      available: byState.DISPONIBLE ?? 0,
      reserved: byState.RESERVADA ?? 0,
      sold: byState.VENDIDA ?? 0,
    };
  }

  const level = await tx.stockLevel.findUnique({
    where: { productId_locationId: { productId: product.id, locationId: locId } },
  });
  return {
    available: level?.available ?? 0,
    reserved: level?.reserved ?? 0,
    sold: 0,
  };
}
