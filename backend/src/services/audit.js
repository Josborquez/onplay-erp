import { prisma } from "../db.js";

// Registra una acción en el log de auditoría (R: §3.6). userId puede ser null
// (ej. intento de login con correo desconocido). No debe romper el flujo
// principal si el registro falla.
export async function audit(action, { userId = null, detail = null } = {}) {
  try {
    await prisma.auditLog.create({ data: { action, userId, detail } });
  } catch (err) {
    console.error("Fallo al registrar auditoría:", err.message);
  }
}
