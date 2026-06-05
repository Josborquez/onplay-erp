// Configuración del cliente, leída de las variables VITE_* en build/dev.

const minutes = Number.parseInt(import.meta.env.VITE_INACTIVITY_MINUTES, 10);
const warning = Number.parseInt(import.meta.env.VITE_IDLE_WARNING_SECONDS, 10);

export const config = {
  apiUrl: import.meta.env.VITE_API_URL || "http://localhost:3000",
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID || "",
  inactivityMs: (Number.isNaN(minutes) || minutes <= 0 ? 10 : minutes) * 60 * 1000,
  idleWarningMs: (Number.isNaN(warning) || warning <= 0 ? 60 : warning) * 1000,
};
