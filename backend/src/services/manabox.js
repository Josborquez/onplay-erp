import { createHash } from "crypto";
import { prisma } from "../db.js";
import { getSetting } from "./settings.js";
import { roundPrice } from "./catalog.js";
import { addStockTx } from "./inventory.js";

// Importación de singles de Magic desde el CSV de ManaBox (bloque-2 §6).
// El ERP recibe el CSV directamente y se vuelve el importador. Solo Magic se
// carga por esta vía (D3); el resto se carga a mano. Lógica heredada de
// onplay-manager: SKU, imagen Scryfall, mapeos y sufijo (Foil).

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

// Parser CSV mínimo (RFC-4180): respeta campos entre comillas, comas internas
// y comillas escapadas (""). Sin dependencias nuevas (CLAUDE.md B5).
function parseCsv(text) {
  const s = text.replace(/^\uFEFF/, ""); // BOM
  const rows = [];
  let record = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\r") {
      // ignorar; el \n cierra el registro
    } else if (c === "\n") {
      record.push(field);
      rows.push(record);
      record = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || record.length) {
    record.push(field);
    rows.push(record);
  }
  return rows;
}

// Convierte el CSV en objetos {columna: valor} usando la primera fila de cabecera.
function parseCsvToObjects(text) {
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cols) => {
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = (cols[i] ?? "").trim();
    });
    return obj;
  });
}

// Mapeo de condición de ManaBox → código corto (heredado de onplay-manager).
const CONDITION_CODE = {
  mint: "M",
  near_mint: "NM",
  excellent: "EX",
  good: "GD",
  light_played: "LP",
  lightly_played: "LP",
  played: "MP",
  moderately_played: "MP",
  heavily_played: "HP",
  poor: "DMG",
  damaged: "DMG",
};

// Mapeo de idioma → nombre para mostrar (el SKU usa el código en mayúsculas).
const LANGUAGE_NAME = {
  en: "Inglés",
  es: "Español",
  pt: "Portugués",
  fr: "Francés",
  de: "Alemán",
  it: "Italiano",
  ja: "Japonés",
  ko: "Coreano",
  ru: "Ruso",
  zhs: "Chino simplificado",
  zht: "Chino tradicional",
};

function conditionCode(raw) {
  const k = (raw || "").toLowerCase();
  return CONDITION_CODE[k] || (raw || "").toUpperCase() || "NM";
}

function languageName(raw) {
  const k = (raw || "").toLowerCase();
  return LANGUAGE_NAME[k] || raw || null;
}

// El foil es todo lo que no sea "normal" (foil, etched, …).
function isFoil(raw) {
  const v = (raw || "").toLowerCase();
  return v !== "" && v !== "normal";
}

function toBool(raw) {
  const v = (raw || "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

// Imagen de Scryfall construida desde el Scryfall ID (heredado de onplay-manager).
function imageUrlFor(scryfallId) {
  if (!scryfallId || scryfallId.length < 2) return null;
  return `https://cards.scryfall.io/normal/front/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`;
}

// Transforma una fila del CSV en los datos de catálogo + cantidad a ingresar.
function transformRow(row, { multiplier, rule }) {
  const setCode = row["Set code"] || "";
  const collectorNumber = row["Collector number"] || "";
  const condition = conditionCode(row["Condition"]);
  const langRaw = row["Language"] || "";
  const langCode = langRaw.toUpperCase();
  const sku = `${setCode.toUpperCase()}-${collectorNumber}-${condition}-${langCode}`;

  const foil = isFoil(row["Foil"]);
  let name = row["Name"] || "";
  if (foil) name += " (Foil)";

  const referencePrice = row["Purchase price"] ? Number(row["Purchase price"]) : null;
  const precio =
    referencePrice == null || !Number.isFinite(referencePrice)
      ? null
      : roundPrice(referencePrice * multiplier, rule);

  const quantity = row["Quantity"] ? parseInt(row["Quantity"], 10) : 0;

  return {
    sku,
    name,
    quantity,
    precio,
    attrs: {
      setCode: setCode || null,
      setName: row["Set name"] || null,
      collectorNumber: collectorNumber || null,
      foil,
      rarity: row["Rarity"] || null,
      condition,
      language: languageName(langRaw),
      scryfallId: row["Scryfall ID"] || null,
      misprint: toBool(row["Misprint"]),
      altered: toBool(row["Altered"]),
      imageUrl: imageUrlFor(row["Scryfall ID"]),
      referencePrice,
    },
  };
}

// Get-or-create del juego Magic (los singles pertenecen a un juego, §3).
async function getOrCreateMagicGameId(tx) {
  const game = await tx.game.upsert({
    where: { name: "Magic: The Gathering" },
    update: {},
    create: { name: "Magic: The Gathering", referencePriceSource: "CardKingdom" },
  });
  return game.id;
}

// Importa un CSV de ManaBox. Idempotente por lote: el hash del contenido se
// guarda en ImportBatch; reimportar el mismo archivo no agrega stock (§6).
export async function importManabox(csvText, { userId } = {}) {
  if (typeof csvText !== "string" || !csvText.trim()) {
    throw err(400, "CSV vacío");
  }

  const hash = createHash("sha256").update(csvText).digest("hex");
  const existing = await prisma.importBatch.findUnique({ where: { hash } });
  if (existing) {
    return {
      alreadyImported: true,
      batchId: existing.id,
      source: existing.source,
      rowCount: existing.rowCount,
      created: 0,
      updated: 0,
      unitsAdded: 0,
    };
  }

  const multiplier = await getSetting("sale_multiplier");
  const rule = await getSetting("rounding_rule");
  const rows = parseCsvToObjects(csvText)
    .map((o) => transformRow(o, { multiplier, rule }))
    .filter((r) => r.quantity > 0 && r.sku);

  return prisma.$transaction(
    async (tx) => {
      const gameId = await getOrCreateMagicGameId(tx);
      let created = 0;
      let updated = 0;
      let unitsAdded = 0;

      for (const r of rows) {
        const found = await tx.product.findUnique({
          where: { sku: r.sku },
          select: { id: true },
        });
        let productId;
        if (found) {
          await tx.product.update({
            where: { id: found.id },
            data: { name: r.name, precio: r.precio, gameId, ...r.attrs },
          });
          productId = found.id;
          updated++;
        } else {
          const product = await tx.product.create({
            data: {
              type: "SINGLE",
              trackingMode: "UNIDAD",
              name: r.name,
              sku: r.sku,
              gameId,
              precio: r.precio,
              ...r.attrs,
            },
          });
          productId = product.id;
          created++;
        }
        await addStockTx(tx, productId, r.quantity, { userId });
        unitsAdded += r.quantity;
      }

      const batch = await tx.importBatch.create({
        data: { source: "MANABOX", hash, rowCount: rows.length, createdById: userId ?? null },
      });

      return {
        alreadyImported: false,
        batchId: batch.id,
        source: "MANABOX",
        rowCount: rows.length,
        created,
        updated,
        unitsAdded,
      };
    },
    { timeout: 120000, maxWait: 20000 }
  );
}
