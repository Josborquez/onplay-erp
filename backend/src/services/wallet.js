import { prisma } from "../db.js";

// Motor de wallet (bloque 4). Saldo de tienda autoritativo: el ERP es la única
// verdad. Reusa el patrón exacto del inventario 2B — saldo cacheado en
// WalletAccount + ledger inmutable en WalletMovement, mutados bajo candado de
// fila (SELECT … FOR UPDATE) dentro de una transacción. Cierra por construcción
// la clase de bugs de la auditoría OnplayWallet (V-001 saldo fantasma, V-006
// doble crédito, race condition de débito). Dinero en CLP entero.

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

// Valida que `monto` sea un entero positivo (los montos del ledger son siempre
// positivos; el signo lo da el `tipo`).
function requireMonto(monto) {
  const n = Number(monto);
  if (!Number.isInteger(n) || n <= 0) throw err(400, "monto inválido");
  return n;
}

// Núcleo común de toda mutación de saldo. Corre dentro de la transacción `db`
// (puede ser el `tx` del checkout del POS). Pasos en orden:
//   0) idempotencia por reference (misma reference => 409, no duplica),
//   1) candado de fila sobre la cuenta del cliente,
//   2) cálculo y validación del nuevo saldo DENTRO del candado (fix race),
//   3) mutación del cache + escritura del ledger, atómicas.
// `delta` es el cambio con signo (+monto crédito/reversa, -monto débito/ajuste).
async function applyMovement(
  db,
  { customerId, tipo, monto, delta, reference, origen, motivo, expiraEn, saleId, performedBy }
) {
  const cid = Number(customerId);
  if (!reference) throw err(400, "reference requerida");

  // 0) Idempotencia.
  const dup = await db.walletMovement.findUnique({ where: { reference } });
  if (dup) throw err(409, "reference ya usada");

  // 1) Candado de fila sobre la cuenta.
  const rows = await db.$queryRawUnsafe(
    `SELECT id, saldo FROM WalletAccount WHERE customerId = ? FOR UPDATE`,
    cid
  );
  if (!rows.length) throw err(404, "wallet inexistente");
  const saldoAntes = Number(rows[0].saldo);

  // 2) Validación del nuevo saldo dentro del candado. Nunca negativo (D4-05).
  const saldoDespues = saldoAntes + delta;
  if (saldoDespues < 0) throw err(422, "saldo insuficiente");

  // 3) Mutar cache + escribir ledger.
  await db.walletAccount.update({
    where: { id: Number(rows[0].id) },
    data: { saldo: saldoDespues },
  });
  return db.walletMovement.create({
    data: {
      customerId: cid,
      tipo,
      monto,
      saldoAntes,
      saldoDespues,
      reference,
      origen,
      motivo: motivo ?? null,
      expiraEn: expiraEn ?? null,
      saleId: saleId ?? null,
      performedBy,
    },
  });
}

// Acreditar (recarga / carga histórica). Suma saldo. No exige saldo previo.
export async function creditar({ customerId, monto, origen, reference, motivo, expiraEn, performedBy }) {
  const m = requireMonto(monto);
  return prisma.$transaction((tx) =>
    applyMovement(tx, {
      customerId,
      tipo: "CREDITO_MANUAL",
      monto: m,
      delta: m,
      reference,
      origen: origen ?? "MANUAL",
      motivo,
      expiraEn,
      performedBy,
    })
  );
}

// Debitar (pago de venta con store credit). Resta saldo, valida suficiencia bajo
// candado. Acepta un `tx` externo para correr dentro de la transacción del
// checkout del POS (bloque 4B): si la venta hace rollback, el débito también.
export async function debitar({ customerId, monto, origen, reference, saleId, performedBy }, tx) {
  const m = requireMonto(monto);
  const run = (db) =>
    applyMovement(db, {
      customerId,
      tipo: "DEBITO_VENTA",
      monto: m,
      delta: -m,
      reference,
      origen: origen ?? "POS_VENTA",
      saleId,
      performedBy,
    });
  return tx ? run(tx) : prisma.$transaction(run);
}

// Ajuste manual (corrección). El signo lo decide el operador; motivo obligatorio
// (es la única vía de corregir y debe quedar justificado). No deja saldo < 0.
export async function ajustar({ customerId, monto, signo, motivo, reference, performedBy }) {
  const m = requireMonto(monto);
  if (signo !== "+" && signo !== "-") throw err(400, "signo inválido");
  if (!motivo || String(motivo).trim() === "") throw err(400, "motivo requerido");
  const delta = signo === "+" ? m : -m;
  return prisma.$transaction((tx) =>
    applyMovement(tx, {
      customerId,
      tipo: "AJUSTE",
      monto: m,
      delta,
      reference,
      origen: "AJUSTE",
      motivo,
      performedBy,
    })
  );
}

// Reversa del débito al anular una venta (bloque 4B). Busca el DEBITO_VENTA de
// la venta y devuelve el mismo monto como REVERSA_VENTA. Idempotente por
// reference = REVERSA-{saleId}: re-anular no duplica el reembolso (devuelve el
// movimiento ya existente). Devuelve null si la venta no pagó con store credit.
export async function revertir({ saleId, performedBy }, tx) {
  const sid = Number(saleId);
  const run = async (db) => {
    const debito = await db.walletMovement.findFirst({
      where: { saleId: sid, tipo: "DEBITO_VENTA" },
    });
    if (!debito) return null; // la venta no se pagó con store credit

    const reference = `REVERSA-${sid}`;
    const ya = await db.walletMovement.findUnique({ where: { reference } });
    if (ya) return ya; // ya revertida: idempotente, no duplica

    return applyMovement(db, {
      customerId: debito.customerId,
      tipo: "REVERSA_VENTA",
      monto: debito.monto,
      delta: debito.monto,
      reference,
      origen: "ANULACION",
      saleId: sid,
      performedBy,
    });
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

// Saldo actual del cliente (cache). 404 si no tiene wallet.
export async function saldoDe(customerId) {
  const acc = await prisma.walletAccount.findUnique({
    where: { customerId: Number(customerId) },
  });
  if (!acc) throw err(404, "wallet inexistente");
  return acc.saldo;
}

// Historial paginado del ledger (más reciente primero).
export async function historial(customerId, { page = 1, size = 50 } = {}) {
  const take = Math.min(Math.max(Number(size) || 50, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;
  return prisma.walletMovement.findMany({
    where: { customerId: Number(customerId) },
    orderBy: { id: "desc" },
    skip,
    take,
  });
}
