import { createApp } from "./app.js";
import { config } from "./config.js";
import { expireReservations } from "./services/inventory.js";

const app = createApp();

app.listen(config.port, () => {
  console.log(`ERP Onplay backend escuchando en :${config.port}`);
});

// Proceso de expiración de reservas vencidas (bloque 2B). Corre cada 60s; los
// tests llaman expireReservations() directo, este timer no corre en test.
setInterval(() => {
  expireReservations().catch(console.error);
}, 60_000);
