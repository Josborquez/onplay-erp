import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";

// Verificación del id_token de Google del lado servidor (R1/R2: la verdad no
// vive en Google). El verificador es inyectable para que los tests no dependan
// de la red ni de un token real.

const realClient = new OAuth2Client(config.googleClientId);

async function realVerify(idToken) {
  const ticket = await realClient.verifyIdToken({
    idToken,
    audience: config.googleClientId,
  });
  const payload = ticket.getPayload();
  return { sub: payload.sub, email: payload.email };
}

let verifier = realVerify;

// Reemplaza el verificador (usado en tests). verifier(idToken) → { sub, email }.
export function setGoogleVerifier(fn) {
  verifier = fn;
}

// Devuelve { sub, email } o null si el token es inválido.
export async function verifyGoogleIdToken(idToken) {
  try {
    const result = await verifier(idToken);
    if (!result || !result.email || !result.sub) return null;
    return { sub: result.sub, email: result.email };
  } catch {
    return null;
  }
}
