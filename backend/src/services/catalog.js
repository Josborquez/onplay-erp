import { prisma } from "../db.js";
import { getSetting } from "./settings.js";

// Catálogo (bloque-2 §3). Producto común + atributos extra de single.
// El inventario (StockUnit, reservas, movimientos) llega en 2B.

// El modo de rastreo se deriva del tipo: singles por unidad, el resto por
// cantidad (§2.2). No se acepta del cliente para que no haya inconsistencia.
function trackingModeFor(type) {
  return type === "SINGLE" ? "UNIDAD" : "CANTIDAD";
}

// Aplica la regla de redondeo configurada (§5.1).
export function roundPrice(value, rule) {
  switch (rule) {
    case "ceil_1000":
      return Math.ceil(value / 1000) * 1000;
    case "round_500":
      return Math.round(value / 500) * 500;
    case "round_100":
      return Math.round(value / 100) * 100;
    case "ceil_500":
    default:
      return Math.ceil(value / 500) * 500;
  }
}

// Precio de venta sugerido para un single: referencia(USD) × multiplicador de
// venta, redondeado (§5.1). Ajustable a mano (si llega `precio`, ese manda).
export async function suggestPrice(referencePrice) {
  if (referencePrice == null) return null;
  const multiplier = await getSetting("sale_multiplier");
  const rule = await getSetting("rounding_rule");
  return roundPrice(Number(referencePrice) * multiplier, rule);
}

// Margen = precio − costo (§2.4). null si falta cualquiera de los dos.
export function margin(product) {
  if (product.precio == null || product.costo == null) return null;
  return product.precio - product.costo;
}

// Serializa un producto para la API, agregando el margen calculado.
export function serializeProduct(product) {
  return {
    ...product,
    referencePrice: product.referencePrice == null ? null : Number(product.referencePrice),
    margen: margin(product),
  };
}

const SINGLE_ATTRS = [
  "setCode",
  "setName",
  "collectorNumber",
  "foil",
  "rarity",
  "condition",
  "language",
  "scryfallId",
  "misprint",
  "altered",
];

// Crea un producto. Para un single sin `precio` explícito, calcula el sugerido
// a partir de `referencePrice` y los Settings.
export async function createProduct(input) {
  const { type, name } = input;
  if (!["SINGLE", "SEALED", "SNACK", "ACCESSORY"].includes(type)) {
    throw Object.assign(new Error("tipo de producto inválido"), { status: 400 });
  }
  if (!name || typeof name !== "string") {
    throw Object.assign(new Error("nombre requerido"), { status: 400 });
  }

  const referencePrice =
    input.referencePrice == null ? null : Number(input.referencePrice);

  let precio = input.precio == null ? null : Math.trunc(Number(input.precio));
  if (precio == null && type === "SINGLE" && referencePrice != null) {
    precio = await suggestPrice(referencePrice);
  }
  const costo = input.costo == null ? null : Math.trunc(Number(input.costo));

  const data = {
    type,
    trackingMode: trackingModeFor(type),
    name,
    sku: input.sku ?? null,
    gameId: input.gameId ?? null,
    isActive: input.isActive ?? true,
    costo,
    precio,
    referencePrice,
  };
  // Atributos de single: solo se copian si vienen.
  for (const attr of SINGLE_ATTRS) {
    if (attr in input) data[attr] = input[attr];
  }

  const product = await prisma.product.create({ data });
  return serializeProduct(product);
}

// Actualiza campos editables a mano (precio, costo, activo, atributos single).
export async function updateProduct(id, input) {
  const data = {};
  if ("precio" in input) data.precio = input.precio == null ? null : Math.trunc(Number(input.precio));
  if ("costo" in input) data.costo = input.costo == null ? null : Math.trunc(Number(input.costo));
  if ("isActive" in input) data.isActive = Boolean(input.isActive);
  if ("name" in input) data.name = input.name;
  if ("referencePrice" in input) {
    data.referencePrice = input.referencePrice == null ? null : Number(input.referencePrice);
  }
  for (const attr of SINGLE_ATTRS) {
    if (attr in input) data[attr] = input[attr];
  }
  const product = await prisma.product.update({ where: { id }, data });
  return serializeProduct(product);
}

export async function listProducts() {
  const products = await prisma.product.findMany({ orderBy: { id: "asc" } });
  return products.map(serializeProduct);
}

export async function getProduct(id) {
  const product = await prisma.product.findUnique({ where: { id } });
  return product ? serializeProduct(product) : null;
}
