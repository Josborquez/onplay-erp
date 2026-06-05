import jwt from "jsonwebtoken";
import { config } from "../config.js";

// El JWT solo transporta el sessionId. El estado real (revocación, inactividad,
// expiración) vive en la BD y se valida server-side en cada request (R3).
export function signSession(sessionId) {
  return jwt.sign({ sessionId }, config.jwtSecret);
}

// Devuelve el payload o null si la firma es inválida.
export function verifySession(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}
