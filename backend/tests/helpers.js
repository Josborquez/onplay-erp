import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { hashPin } from "../src/lib/pin.js";

// Limpia las tablas entre tests (orden hijos → padres por las FKs).
export async function resetDb() {
  // POS (bloque 3): Payment→Sale, SaleLine→Sale/Reservation/StockUnit/Product,
  // Sale→CashSession/User, CashSession→Terminal/User. Antes que sus padres.
  await prisma.payment.deleteMany();
  await prisma.saleLine.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.cashSession.deleteMany();
  await prisma.terminal.deleteMany();
  await prisma.counter.deleteMany();
  // Importaciones (2C): ImportBatch referencia User.
  await prisma.importBatch.deleteMany();
  // Inventario (2B): StockUnit referencia Reservation/Product/Location.
  await prisma.stockMovement.deleteMany();
  await prisma.stockUnit.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.stockLevel.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  // Catálogo (bloque 2): Product referencia Game.
  await prisma.product.deleteMany();
  await prisma.game.deleteMany();
  await prisma.location.deleteMany();
  await prisma.setting.deleteMany();
}

// Crea un usuario y devuelve su token de sesión (para tests de rutas protegidas).
export async function loginAs(app, request, overrides = {}) {
  const password = overrides.password || "Secret!123";
  const user = await createUser({ ...overrides, password });
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: user.email, password });
  return { user, token: res.body.token };
}

// Factory de usuarios para los tests.
export async function createUser({
  email,
  name = "Test User",
  role = "SALES_ASSISTANT",
  password = "Secret!123",
  pin = "4321",
  isActive = true,
  googleSub = null,
} = {}) {
  return prisma.user.create({
    data: {
      email,
      name,
      role,
      passwordHash: password ? await hashPassword(password) : null,
      pinHash: await hashPin(pin),
      isActive,
      googleSub,
    },
  });
}

// Mueve lastActivityAt de una sesión hacia atrás N minutos, para simular
// inactividad sin esperar en tiempo real.
export async function ageSession(sessionId, minutes) {
  const past = new Date(Date.now() - minutes * 60 * 1000);
  await prisma.session.update({
    where: { id: sessionId },
    data: { lastActivityAt: past },
  });
}
