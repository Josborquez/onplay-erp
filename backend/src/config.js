import "dotenv/config";

// Carga y valida la configuración del entorno al arranque.
// Si algo crítico falta o es inválido, se lanza un error y el proceso no levanta.

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`La variable ${name} debe ser un entero positivo`);
  }
  return n;
}

const jwtSecret = required("JWT_SECRET");
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET debe tener al menos 32 caracteres");
}

// En tests usamos TEST_DATABASE_URL; en el resto, DATABASE_URL.
const isTest = process.env.NODE_ENV === "test";
const databaseUrl = isTest
  ? required("TEST_DATABASE_URL")
  : required("DATABASE_URL");

// Propagamos la URL elegida a DATABASE_URL para que PrismaClient la tome.
process.env.DATABASE_URL = databaseUrl;

export const config = {
  isTest,
  databaseUrl,
  jwtSecret,
  // GOOGLE_CLIENT_ID es requerido para el login Google real, pero los tests
  // inyectan un verificador, así que no lo exigimos en modo test.
  googleClientId: isTest ? process.env.GOOGLE_CLIENT_ID || "" : required("GOOGLE_CLIENT_ID"),
  inactivityMinutes: intEnv("INACTIVITY_MINUTES", 10),
  sessionAbsoluteHours: intEnv("SESSION_ABSOLUTE_HOURS", 12),
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  port: intEnv("PORT", 3000),
};
