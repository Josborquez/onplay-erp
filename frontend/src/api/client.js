import { config } from "../config.js";

// Wrapper de fetch: inyecta el Bearer, devuelve {status,data} y centraliza la
// reacción a 401/423 (servidor = autoridad, R3). El AuthContext registra los
// handlers y el getter del token vía configureClient.

let getToken = () => null;
let onUnauthorized = () => {};
let onLocked = () => {};

export function configureClient(handlers) {
  if (handlers.tokenGetter) getToken = handlers.tokenGetter;
  if (handlers.onUnauthorized) onUnauthorized = handlers.onUnauthorized;
  if (handlers.onLocked) onLocked = handlers.onLocked;
}

export async function apiFetch(path, { method = "GET", body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { status: 0, data: { error: "no se pudo conectar con el servidor" } };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  // 423 → la pantalla queda bloqueada; 401 → la sesión ya no sirve.
  if (res.status === 423) onLocked();
  else if (res.status === 401) onUnauthorized();

  return { status: res.status, data };
}
