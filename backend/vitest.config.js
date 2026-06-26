import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { NODE_ENV: "test" },
    // Los tests comparten una BD MySQL; correrlos en serie evita carreras.
    fileParallelism: false,
    sequence: { concurrent: false },
    // BD remota (Hostinger) lenta: los tests de POS con muchos round-trips de
    // setup rozan los 60s. Margen amplio para no falsear timeouts por latencia.
    hookTimeout: 60000,
    testTimeout: 90000,
  },
});
