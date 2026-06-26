import { createApp } from "./app.js";
import { config } from "./config.js";
import { expireReservations } from "./services/inventory.js";
import { expireAbandonedSales } from "./services/pos.js";

const app = createApp();

app.listen(config.port, () => {
  console.log(`ERP Onplay backend escuchando en :${config.port}`);
});

// Proceso de expiración de reservas vencidas (bloque 2B) y, tras él, marcado de
// los carritos POS cuyas reservas ya expiraron como ABANDONADA (bloque 3B).
// Corre cada 60s; los tests llaman estas funciones directo, el timer no corre
// en test.
setInterval(() => {
  expireReservations()
    .then(() => expireAbandonedSales())
    .catch(console.error);
}, 60_000);
