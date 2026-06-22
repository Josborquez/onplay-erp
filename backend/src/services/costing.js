import { prisma } from "../db.js";
import { getSetting } from "./settings.js";

// Costo en la compra (bloque-2 §5.2). Dos orígenes:
//  - Trade: costo = referencia(USD) × multiplicador de compra → CLP.
//  - Bulk / sellado abierto: el costo total del lote se reparte por unidad
//    ponderado por el precio de venta.
// El costo es nuevo en el ERP (no sale del CSV de ManaBox). margen = precio −
// costo se calcula al leer (catalog.serializeProduct), no se persiste.

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

function marginOf(precio, costo) {
  return precio == null || costo == null ? null : precio - costo;
}

// Trade (cliente vende sus cartas): costo limpio por unidad = referencia ×
// multiplicador de compra. Usa la referencia guardada del producto salvo que
// se pase una explícita.
export async function applyTradeCost(productId, { referencePrice } = {}) {
  const product = await prisma.product.findUnique({ where: { id: Number(productId) } });
  if (!product) throw err(404, "producto inexistente");

  const ref =
    referencePrice != null
      ? Number(referencePrice)
      : product.referencePrice == null
        ? null
        : Number(product.referencePrice);
  if (ref == null || !Number.isFinite(ref)) {
    throw err(400, "falta precio de referencia para el trade");
  }

  const buyMultiplier = await getSetting("buy_multiplier");
  const costo = Math.round(ref * buyMultiplier);
  const updated = await prisma.product.update({
    where: { id: product.id },
    data: { costo },
  });

  return {
    productId: product.id,
    costo,
    precio: updated.precio,
    margen: marginOf(updated.precio, costo),
  };
}

// Bulk / sellado abierto: reparte `totalCost` entre las cartas del lote
// ponderado por su precio de venta. Σvalor = Σ(cantidad × precio); el costo por
// unidad de cada carta = totalCost × precio / Σvalor (una carta que vale el 10%
// del valor del lote carga el 10% del costo).
export async function distributeBulkCost(items, totalCost) {
  const total = Math.trunc(Number(totalCost));
  if (!Number.isFinite(total) || total <= 0) throw err(400, "costo total inválido");
  if (!Array.isArray(items) || items.length === 0) throw err(400, "items requeridos");

  const normalized = items.map((it) => ({
    productId: Number(it.productId),
    quantity: it.quantity == null ? 1 : Number(it.quantity),
  }));
  for (const it of normalized) {
    if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
      throw err(400, "cantidad inválida");
    }
  }

  const products = await prisma.product.findMany({
    where: { id: { in: normalized.map((i) => i.productId) } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  let sumValue = 0;
  for (const it of normalized) {
    const p = byId.get(it.productId);
    if (!p) throw err(404, `producto ${it.productId} inexistente`);
    if (p.precio == null) throw err(400, `producto ${it.productId} sin precio de venta`);
    sumValue += it.quantity * p.precio;
  }
  if (sumValue <= 0) throw err(400, "el valor del lote es cero");

  const lines = await prisma.$transaction(async (tx) => {
    const out = [];
    for (const it of normalized) {
      const p = byId.get(it.productId);
      const costo = Math.round((total * p.precio) / sumValue);
      await tx.product.update({ where: { id: p.id }, data: { costo } });
      out.push({
        productId: p.id,
        quantity: it.quantity,
        precio: p.precio,
        costo,
        margen: marginOf(p.precio, costo),
        lineCost: costo * it.quantity,
      });
    }
    return out;
  });

  return { totalCost: total, sumValue, items: lines };
}
