import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server en 5173 (origen ya permitido por el CORS del backend).
export default defineConfig({
  plugins: [react()],
  // strictPort: nunca saltar a otro puerto (5174/5175); así no se rompe el CORS
  // ni el origen autorizado en Google, que están fijos a 5173.
  server: { port: 5173, strictPort: true },
});
