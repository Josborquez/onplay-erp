import bcrypt from "bcrypt";

const ROUNDS = 12;

// PIN de re-validación dentro de una sesión (desbloqueo). Hasheado (R5/R6),
// comparación timing-safe vía bcrypt.compare. El PIN no abre sesión.
export function hashPin(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPin(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}
