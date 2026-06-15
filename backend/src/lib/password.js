import bcrypt from "bcrypt";

const ROUNDS = 12;

// Hash dummy (mismo cost que los reales) para gastar el tiempo de bcrypt cuando
// no hay hash que comparar. Evita filtrar por timing si el correo existe o no
// (R4): sin esto, un correo inexistente respondería en ~1ms y uno real en ~100ms.
const DUMMY_HASH = "$2b$12$5SAQ8P4OuxzgbayLJgibk.yiPOUIiPHgWgj0u.t02vvDL6hyj559S";

// Clave de login. bcrypt.compare es constant-time → cumple R5 (timing-safe).
export function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!hash) {
    // Igualamos el costo de un compare real y devolvemos false.
    await bcrypt.compare(plain, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(plain, hash);
}
