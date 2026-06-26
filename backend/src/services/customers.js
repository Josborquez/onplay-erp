import { prisma } from "../db.js";

// Clientes del Bloque 4. Población separada del User de staff (bloque 1). El
// WalletAccount se crea junto con el Customer (saldo 0, D4-03) para simplificar
// el candado del wallet (siempre existe la fila a bloquear).

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

// Normaliza un campo opcional: "" o solo espacios → null (para no chocar con el
// índice único de rut/email con cadenas vacías).
function optional(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

// Crea un cliente con su wallet (saldo 0). nombre obligatorio; rut/email
// opcionales pero únicos si vienen → 409 si ya existen (AC-4.01).
export async function createCustomer({ nombre, rut, email, telefono } = {}) {
  const name = optional(nombre);
  if (!name) throw err(400, "nombre requerido");
  const rutN = optional(rut);
  const emailN = optional(email);

  if (rutN) {
    const dup = await prisma.customer.findUnique({ where: { rut: rutN } });
    if (dup) throw err(409, "rut ya registrado");
  }
  if (emailN) {
    const dup = await prisma.customer.findUnique({ where: { email: emailN } });
    if (dup) throw err(409, "email ya registrado");
  }

  return prisma.customer.create({
    data: {
      nombre: name,
      rut: rutN,
      email: emailN,
      telefono: optional(telefono),
      wallet: { create: {} },
    },
    include: { wallet: true },
  });
}

// Detalle de un cliente con su wallet. 404 si no existe.
export async function getCustomer(customerId) {
  const customer = await prisma.customer.findUnique({
    where: { id: Number(customerId) },
    include: { wallet: true },
  });
  if (!customer) throw err(404, "cliente inexistente");
  return customer;
}

// Listado/búsqueda. Con q filtra por nombre, rut o email (contains).
export async function listCustomers({ q } = {}) {
  const where = q
    ? {
        OR: [
          { nombre: { contains: q } },
          { rut: { contains: q } },
          { email: { contains: q } },
        ],
      }
    : {};
  return prisma.customer.findMany({
    where,
    orderBy: { id: "desc" },
    include: { wallet: true },
  });
}

// Edita datos de contacto. No cambia el saldo. Revalida unicidad de rut/email.
export async function updateCustomer(customerId, { nombre, rut, email, telefono } = {}) {
  const customer = await getCustomer(customerId);
  const data = {};

  if (nombre !== undefined) {
    const name = optional(nombre);
    if (!name) throw err(400, "nombre requerido");
    data.nombre = name;
  }
  if (rut !== undefined) {
    const rutN = optional(rut);
    if (rutN) {
      const dup = await prisma.customer.findUnique({ where: { rut: rutN } });
      if (dup && dup.id !== customer.id) throw err(409, "rut ya registrado");
    }
    data.rut = rutN;
  }
  if (email !== undefined) {
    const emailN = optional(email);
    if (emailN) {
      const dup = await prisma.customer.findUnique({ where: { email: emailN } });
      if (dup && dup.id !== customer.id) throw err(409, "email ya registrado");
    }
    data.email = emailN;
  }
  if (telefono !== undefined) data.telefono = optional(telefono);

  return prisma.customer.update({
    where: { id: customer.id },
    data,
    include: { wallet: true },
  });
}

// Soft-disable / re-enable. Nunca borra saldo ni historial.
export async function setActivo(customerId, activo) {
  const customer = await getCustomer(customerId);
  return prisma.customer.update({
    where: { id: customer.id },
    data: { activo: Boolean(activo) },
    include: { wallet: true },
  });
}
