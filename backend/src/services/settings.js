import { prisma } from "../db.js";

// Parámetros de negocio editables en runtime (bloque-2 §5.3).
// Viven en la tabla Setting (clave-valor, texto). Aquí están sus defaults,
// su tipo y su validación. Los secretos NO van aquí: van en variables de
// entorno (DATABASE_URL, JWT_SECRET, …).
const ROUNDING_RULES = ["ceil_500", "ceil_1000", "round_500", "round_100"];

// key → { type, default, validate }. El default es el punto de partida que el
// administrador de tienda ajusta desde la interfaz.
export const SETTING_DEFS = {
  // Multiplicador de venta: precio = referencia(USD) × este valor → CLP (§5.1).
  sale_multiplier: { type: "number", default: 1000 },
  // Multiplicador de compra (trade): costo = referencia(USD) × este valor (§5.2).
  buy_multiplier: { type: "number", default: 400 },
  // Tipo de cambio USD→CLP para el cálculo de margen (§5.2). Punto de partida;
  // lo ajusta el administrador.
  usd_clp: { type: "number", default: 950 },
  // Regla de redondeo del precio (heredada de onplay-manager, §5.1).
  rounding_rule: {
    type: "enum",
    default: "ceil_500",
    values: ROUNDING_RULES,
  },
  // TTL de reserva en minutos. El mecanismo se construye en 2B; el valor fino
  // se ajusta en el bloque 6 (pago real). (§4)
  reservation_ttl_minutes: { type: "number", default: 30 },
};

const KNOWN_KEYS = Object.keys(SETTING_DEFS);

// Devuelve todos los parámetros (default + lo guardado en BD; la BD manda).
export async function getAllSettings() {
  const rows = await prisma.setting.findMany();
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const result = {};
  for (const key of KNOWN_KEYS) {
    const raw = stored.has(key) ? stored.get(key) : String(SETTING_DEFS[key].default);
    result[key] = parseValue(key, raw);
  }
  return result;
}

// Lee un parámetro tipado (default si no está en BD).
export async function getSetting(key) {
  if (!KNOWN_KEYS.includes(key)) {
    throw Object.assign(new Error("parámetro desconocido"), { status: 400 });
  }
  const row = await prisma.setting.findUnique({ where: { key } });
  const raw = row ? row.value : String(SETTING_DEFS[key].default);
  return parseValue(key, raw);
}

// Valida y guarda (upsert) un parámetro. Devuelve el valor tipado.
export async function setSetting(key, value) {
  const def = SETTING_DEFS[key];
  if (!def) {
    throw Object.assign(new Error("parámetro desconocido"), { status: 400 });
  }
  const stringValue = validateValue(key, value);
  await prisma.setting.upsert({
    where: { key },
    update: { value: stringValue },
    create: { key, value: stringValue },
  });
  return parseValue(key, stringValue);
}

function parseValue(key, raw) {
  return SETTING_DEFS[key].type === "number" ? Number(raw) : raw;
}

// Valida según el tipo y devuelve el valor normalizado como texto (para guardar).
function validateValue(key, value) {
  const def = SETTING_DEFS[key];
  if (def.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw Object.assign(new Error("valor numérico inválido"), { status: 400 });
    }
    return String(n);
  }
  // enum
  if (!def.values.includes(value)) {
    throw Object.assign(new Error("valor no permitido"), { status: 400 });
  }
  return value;
}
