# Estado del Proyecto — ERP Onplay

## 1. Resumen

ERP autoritativo para tienda TCG (Onplay Games). El ERP es **dueño de la verdad del stock**: ningún canal descuenta inventario por su cuenta, todo pasa por el contrato `reservar → confirmar | liberar` bajo candado de fila.

**Estado global:** Bloques 1, 2, 3 y 4 completos y verificados en backend (**78 tests en verde** contra MySQL real). Frontend solo Bloque 1 (login).

---

## 2. Arquitectura

**Stack (fijo, B5):** Node.js + Express + Prisma + MySQL · React + Vite + Tailwind.

```
backend/
  src/
    config.js · db.js · app.js · server.js
    lib/         password · pin · jwt · google      (bcrypt rounds 12, timing-safe)
    middleware/  auth (requireAuth/requireSession) · requireRole
    routes/      auth · protected · catalog · settings · inventory · pos · customers · wallet
    services/    audit · catalog · settings · inventory · manabox · costing · pos · customers · wallet
  prisma/        schema.prisma · seed.js
  tests/         auth · catalog · inventory · manabox · costing · pos · wallet
frontend/
  src/           auth/ · pages/ · components/ · api/client.js   (solo Bloque 1)
```

**Decisiones clave:**
- ESM JavaScript (no TypeScript) por simplicidad.
- Sesión server-side: el JWT lleva solo `sessionId`; el estado real vive en tabla `Session`. Inactividad → **423 Locked** (no revoca); revoke/expiry → 401.
- Dinero en **CLP entero** (sin decimales/floats).
- Candado de fila vía `SELECT … FOR UPDATE` dentro de `prisma.$transaction` en toda mutación de stock.
- Seguridad: helmet, CORS whitelist, rate-limit en login/unlock, credenciales hasheadas, errores de login genéricos (no revelan si el correo existe).
- BD: Hostinger MySQL remoto, **prod y test separadas**.

**Modelo de datos:** 21 modelos, 10 enums.
- *Bloque 1:* `User`, `Session`, `AuditLog` + enum `Role`.
- *Bloque 2:* `Game`, `Product`, `Setting`, `Location`, `StockUnit`, `StockLevel`, `Reservation`, `StockMovement`, `ImportBatch` + enums `ProductType`, `TrackingMode`, `StockUnitState`, `ReservationState`, `StockMovementType`.
- *Bloque 3:* `Terminal`, `CashSession`, `Sale`, `SaleLine`, `Counter`, `Payment` + enums `CashSessionState`, `SaleState`, `PaymentMethod`.
- *Bloque 4:* `Customer`, `WalletAccount`, `WalletMovement` + enum `WalletMovementType`. Cambios aditivos al Bloque 3: `Payment.walletMovementId`, `Sale.customerId`.

---

## 3. Bloques desarrollados

| Bloque | Alcance | Estado | Tests |
|---|---|---|---|
| **1 — Login** | Login correo+clave y Google, sesión server-side, bloqueo por inactividad + PIN, roles | Backend + Frontend | 13 |
| **2A — Catálogo + Settings** | Productos (singles/sellados/snacks), juegos, parámetros de negocio en runtime, sugerencia de precio | Backend | 9 |
| **2B — Motor de inventario** | `addStock/reserve/confirm/release` bajo candado de fila, 2 modos (UNIDAD/CANTIDAD), TTL de reservas | Backend | 10 |
| **2C — Import ManaBox** | Parser CSV propio, SKU determinista, idempotencia por hash de archivo, imágenes Scryfall | Backend | 3 |
| **2D — Costo en compra** | Costo de trade (ref × buy_multiplier), reparto de costo bulk ponderado por precio | Backend | 5 |
| **3 — Canal POS** | Caja, carrito↔inventario, checkout atómico, folio sin huecos, descuentos, anulación, cuadre | Backend | 22 |
| **4A — Motor de wallet** | `Customer` + saldo de tienda: ledger inmutable (`creditar/debitar/ajustar/revertir`) bajo candado de fila, idempotente por `reference`, PIN propio/supervisor | Backend | 10 |
| **4B — Integración POS** | `STORE_CREDIT` como medio de pago: débito atómico en el checkout (`Payment.walletMovementId` 1:1) y reversa automática al anular; saldo insuficiente hace rollback total | Backend | 6 |

**Pendientes (no iniciados):** Bloque 5 (WooCommerce — el ERP toma la verdad del stock), Bloque 6 (pagos reales Webpay/Mercado Pago). Hasta ahí el "pago confirmado" es simulado.

---

## 4. API desarrollada

Base: `/api` · Auth: `Bearer <token>` salvo donde se indica.

### Auth — `/api/auth`
| Método | Ruta | Acceso |
|---|---|---|
| POST | `/login` | público (rate-limited) |
| POST | `/google` | público (rate-limited) |
| POST | `/unlock` | sesión (pantalla bloqueada, rate-limited) |
| POST | `/logout` | sesión |
| GET | `/me` | autenticado |

### Catálogo — `/api`
| Método | Ruta | Acceso |
|---|---|---|
| POST/GET | `/games` | escritura: admin |
| POST | `/products` | admin |
| GET | `/products` · `/products/:id` | autenticado |
| PATCH | `/products/:id` | admin |

### Settings — `/api`
| Método | Ruta | Acceso |
|---|---|---|
| GET | `/settings` | autenticado |
| PATCH | `/settings/:key` | admin |

### Inventario — `/api/inventory`
| Método | Ruta | Acceso |
|---|---|---|
| POST | `/stock` | admin |
| POST | `/import/manabox` (text/csv) | admin |
| POST | `/cost/trade` · `/cost/bulk` | admin |
| POST | `/reserve` | staff |
| POST | `/reservations/:id/confirm` · `/release` | staff |
| GET | `/products/:id/stock` | autenticado |

### POS — `/api/pos`
| Método | Ruta | Acceso |
|---|---|---|
| POST | `/ventas` | operar (vendedor/admin) |
| POST/DELETE | `/ventas/:id/lineas` · `/lineas/:lineaId` | operar |
| POST | `/ventas/:id/checkout` | operar |
| GET | `/ventas` · `/ventas/:id` | lectura (+contador) |
| PATCH | `/ventas/:id/descuento` | operar (PIN supervisor si supera umbral) |
| POST | `/ventas/:id/anular` | admin + PIN propio |
| POST | `/sesiones` (abrir caja) | operar |
| GET | `/sesiones/activa` | lectura |
| POST | `/sesiones/:id/cerrar` (cuadre, PIN si dif>umbral) | operar |
| POST | `/sesiones/:id/no-sale` | operar + PIN |

### Clientes — `/api/customers`
| Método | Ruta | Acceso |
|---|---|---|
| POST | `/customers` | operar (alta en mostrador) |
| GET | `/customers` · `/customers/:id` · `?q=` | autenticado |
| PATCH | `/customers/:id` | admin |
| PATCH | `/customers/:id/activo` | admin (soft-disable) |

### Wallet — `/api/wallet`
| Método | Ruta | Acceso |
|---|---|---|
| GET | `/wallet/:customerId` · `/movimientos` | lectura (+contador) |
| POST | `/wallet/:customerId/creditar` | operar + PIN propio (PIN supervisor sobre umbral) |
| POST | `/wallet/:customerId/ajustar` | admin + PIN + motivo |

No hay endpoint de débito manual: el saldo solo se gasta vía checkout del POS.

### Otros
- `GET /api/health` — público.
- `GET /api/admin/ping` — demo de guarda por rol (SUPER_ADMIN).

**Matriz de roles:** `SUPER_ADMIN` / `STORE_ADMIN` = todo · `SALES_ASSISTANT` = opera POS, no anula · `ACCOUNTANT` = solo lectura.
