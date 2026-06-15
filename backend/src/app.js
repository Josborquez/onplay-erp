import express from "express";
import helmet from "helmet";
import cors from "cors";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { protectedRouter } from "./routes/protected.js";
import { catalogRouter } from "./routes/catalog.js";
import { settingsRouter } from "./routes/settings.js";
import { inventoryRouter } from "./routes/inventory.js";

// Construye la app Express. Exportable para montarla en los tests (Supertest)
// sin levantar un servidor.
export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins, // whitelist (§7)
      credentials: true,
    })
  );
  app.use(express.json());

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRouter);
  app.use("/api", protectedRouter);
  app.use("/api", catalogRouter);
  app.use("/api", settingsRouter);
  app.use("/api", inventoryRouter);

  // Manejador de errores genérico: no filtra detalles internos.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "error interno" });
  });

  return app;
}
