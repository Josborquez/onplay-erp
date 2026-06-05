import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password.js";
import { hashPin } from "../src/lib/pin.js";

// Seed inicial: al menos un Super admin sistema (criterio "primer ingreso").
// Sin él, nadie podría entrar la primera vez. Idempotente vía upsert.

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || "admin@onplaygames.cl";
  const name = process.env.SEED_ADMIN_NAME || "Super Admin";
  const password = process.env.SEED_ADMIN_PASSWORD || "ChangeMe!2026";
  const pin = process.env.SEED_ADMIN_PIN || "1234";

  const passwordHash = await hashPassword(password);
  const pinHash = await hashPin(pin);

  const user = await prisma.user.upsert({
    where: { email },
    update: {}, // no pisamos credenciales existentes en re-seeds
    create: {
      email,
      name,
      role: "SUPER_ADMIN",
      passwordHash,
      pinHash,
      isActive: true,
    },
  });

  console.log(`Seed OK — Super admin: ${user.email} (id ${user.id})`);

  // Usuario opcional SALES_ASSISTANT: sirve para probar la guarda por rol (403).
  const salesEmail = process.env.SEED_SALES_EMAIL || "vendedor@onplaygames.cl";
  const salesName = process.env.SEED_SALES_NAME || "Vendedor Demo";
  const salesPassword = process.env.SEED_SALES_PASSWORD || "ChangeMe!2026";
  const salesPin = process.env.SEED_SALES_PIN || "5678";

  const sales = await prisma.user.upsert({
    where: { email: salesEmail },
    update: {},
    create: {
      email: salesEmail,
      name: salesName,
      role: "SALES_ASSISTANT",
      passwordHash: await hashPassword(salesPassword),
      pinHash: await hashPin(salesPin),
      isActive: true,
    },
  });

  console.log(`Seed OK — Sales assistant: ${sales.email} (id ${sales.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
