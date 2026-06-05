import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();

app.listen(config.port, () => {
  console.log(`ERP Onplay backend escuchando en :${config.port}`);
});
