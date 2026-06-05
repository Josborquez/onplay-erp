import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { setGoogleVerifier } from "../src/lib/google.js";
import { resetDb, createUser, ageSession } from "./helpers.js";
import { config } from "../src/config.js";

// Verificador de Google inyectado: traduce idToken → perfil, sin red ni token real.
// Convención: idToken con forma "valid:<email>:<sub>" se considera válido.
setGoogleVerifier(async (idToken) => {
  if (typeof idToken !== "string" || !idToken.startsWith("valid:")) {
    throw new Error("token google inválido");
  }
  const [, email, sub] = idToken.split(":");
  return { email, sub: sub || "google-sub-1" };
});

const app = createApp();

// Helper: encuentra la sesión activa más reciente de un usuario.
async function latestSession(userId) {
  return prisma.session.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Bloque 1 — login, sesión y bloqueo (§5)", () => {
  // 1. Login Google de usuario pre-registrado → 200 + token.
  it("1) usuario pre-registrado entra con Google", async () => {
    const user = await createUser({ email: "g@onplay.cl" });
    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: `valid:${user.email}:sub-123` });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  // 2. Login correo+clave de pre-registrado → 200 + token.
  it("2) usuario pre-registrado entra con correo + clave", async () => {
    await createUser({ email: "u@onplay.cl", password: "Secret!123" });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "u@onplay.cl", password: "Secret!123" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  // 3. No registrado (Google válido / correo desconocido) → 401 genérico.
  it("3) no registrado no entra y ve mensaje genérico", async () => {
    const g = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "valid:desconocido@x.cl:sub-9" });
    expect(g.status).toBe(401);
    expect(g.body.error).toBe("acceso no autorizado");

    const p = await request(app)
      .post("/api/auth/login")
      .send({ email: "nadie@x.cl", password: "loquesea" });
    expect(p.status).toBe(401);
    expect(p.body.error).toBe("acceso no autorizado");
  });

  // 4. Usuario inactivo → 401.
  it("4) usuario inactivo no puede entrar", async () => {
    await createUser({ email: "off@onplay.cl", password: "Secret!123", isActive: false });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "off@onplay.cl", password: "Secret!123" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("acceso no autorizado");
  });

  // 5. Inactividad > N → request protegida da 423; la sesión NO se revoca.
  it("5) inactividad bloquea (423) sin revocar la sesión", async () => {
    const user = await createUser({ email: "idle@onplay.cl", password: "Secret!123" });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "Secret!123" });
    const token = login.body.token;

    const session = await latestSession(user.id);
    await ageSession(session.id, config.inactivityMinutes + 1);

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(423);

    const after = await prisma.session.findUnique({ where: { id: session.id } });
    expect(after.revokedAt).toBeNull();
  });

  // 6. unlock con PIN correcto → 200; PIN incorrecto → sigue 423.
  it("6) unlock con PIN correcto desbloquea; incorrecto sigue bloqueado", async () => {
    const user = await createUser({
      email: "pin@onplay.cl",
      password: "Secret!123",
      pin: "4321",
    });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "Secret!123" });
    const token = login.body.token;
    const session = await latestSession(user.id);
    await ageSession(session.id, config.inactivityMinutes + 1);

    const bad = await request(app)
      .post("/api/auth/unlock")
      .set("Authorization", `Bearer ${token}`)
      .send({ pin: "0000" });
    expect(bad.status).toBe(423);

    const good = await request(app)
      .post("/api/auth/unlock")
      .set("Authorization", `Bearer ${token}`)
      .send({ pin: "4321" });
    expect(good.status).toBe(200);

    // Tras desbloquear, la ruta protegida vuelve a responder 200.
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
  });

  // 7. Actividad refresca el contador (lastActivityAt avanza).
  it("7) la actividad reinicia el contador de inactividad", async () => {
    const user = await createUser({ email: "act@onplay.cl", password: "Secret!123" });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "Secret!123" });
    const token = login.body.token;

    const session = await latestSession(user.id);
    // Envejecemos un poco pero por debajo del umbral.
    await ageSession(session.id, config.inactivityMinutes - 1);
    const before = (await prisma.session.findUnique({ where: { id: session.id } }))
      .lastActivityAt;

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const after = (await prisma.session.findUnique({ where: { id: session.id } }))
      .lastActivityAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  // 8. logout → sesión revocada; request posterior → 401.
  it("8) logout cierra la sesión y exige re-login", async () => {
    const user = await createUser({ email: "out@onplay.cl", password: "Secret!123" });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "Secret!123" });
    const token = login.body.token;

    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(logout.status).toBe(200);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(401);
  });

  // 9. Rol insuficiente en /api/admin/ping → 403.
  it("9) rol insuficiente devuelve 403", async () => {
    const user = await createUser({
      email: "sales@onplay.cl",
      password: "Secret!123",
      role: "SALES_ASSISTANT",
    });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "Secret!123" });
    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(403);
  });

  // 10. Ruta protegida sin JWT → 401.
  it("10) ruta protegida sin JWT devuelve 401", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  // 11. En BD: passwordHash / pinHash no son texto plano (formato bcrypt).
  it("11) clave y PIN se guardan hasheados (formato bcrypt)", async () => {
    await createUser({ email: "hash@onplay.cl", password: "Secret!123", pin: "4321" });
    const u = await prisma.user.findUnique({ where: { email: "hash@onplay.cl" } });
    expect(u.passwordHash).not.toBe("Secret!123");
    expect(u.pinHash).not.toBe("4321");
    expect(u.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(u.pinHash).toMatch(/^\$2[aby]\$\d{2}\$/);
  });

  // 12. Seed Super admin permite login inicial.
  it("12) el Super admin seed permite el primer ingreso", async () => {
    // Simulamos el seed creando el Super admin con clave conocida.
    await createUser({
      email: "admin@onplaygames.cl",
      name: "Super Admin",
      role: "SUPER_ADMIN",
      password: "ChangeMe!2026",
      pin: "1234",
    });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@onplaygames.cl", password: "ChangeMe!2026" });
    expect(login.status).toBe(200);

    const ping = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", `Bearer ${login.body.token}`);
    expect(ping.status).toBe(200);
    expect(ping.body.pong).toBe(true);
  });

  // 13. Acciones (LOGIN, LOGOUT, UNLOCK) quedan en AuditLog con userId + timestamp.
  it("13) las acciones relevantes quedan auditadas", async () => {
    const user = await createUser({
      email: "audit@onplay.cl",
      password: "Secret!123",
      pin: "4321",
    });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "Secret!123" });
    const token = login.body.token;

    const session = await latestSession(user.id);
    await ageSession(session.id, config.inactivityMinutes + 1);
    await request(app)
      .post("/api/auth/unlock")
      .set("Authorization", `Bearer ${token}`)
      .send({ pin: "4321" });
    await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`);

    const logs = await prisma.auditLog.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("LOGIN");
    expect(actions).toContain("UNLOCK");
    expect(actions).toContain("LOGOUT");
    for (const l of logs) {
      expect(l.userId).toBe(user.id);
      expect(l.createdAt).toBeInstanceOf(Date);
    }
  });
});
