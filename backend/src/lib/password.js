import bcrypt from "bcrypt";

const ROUNDS = 12;

// Clave de login. bcrypt.compare es constant-time → cumple R5 (timing-safe).
export function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}
