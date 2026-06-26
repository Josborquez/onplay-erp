# Bloque 4 — Wallet del Cliente (Saldo de Tienda)

> **Proyecto:** onplay-erp · **Dominio:** erp.onplaygames.cl
> **Estado del documento:** BORRADOR para revisión — contiene decisiones a confirmar (§11)
> **Depende de:** Bloque 1 (auth/sesión), Bloque 2 (motor de inventario + Settings) y Bloque 3 (canal POS), los tres **construidos y verificados** (62 tests en verde contra MySQL real).
> **Modelo arquitectónico:** Model A — el ERP es la única fuente de verdad. El wallet del cliente es **autoridad de saldo** dentro del ERP, igual que el motor de inventario es autoridad de stock. Ningún canal externo lee ni escribe este saldo en este bloque.

---

## 0. Propósito

El Bloque 4 da a cada cliente un **saldo de tienda** (store credit) administrado por el ERP como única fuente de verdad, y lo cablea como medio de pago en el POS del Bloque 3.

Objetivo de negocio directo: el cliente puede **dejar saldo a favor y gastarlo en mostrador**, con cada movimiento auditado y sin posibilidad de gastar el mismo peso dos veces.

Este bloque es también la corrección de raíz de toda la clase de bugs que documentó la auditoría del OnplayWallet anterior (V-001 saldo fantasma, V-006 doble crédito, race condition de débito). Esos bugs **no eran de implementación: eran arquitectónicos** — venían de tener dos verdades del saldo (el `credit_balance` del POS + la tabla de transacciones de WordPress) sincronizadas a mano y a destiempo. Con una sola verdad y el mismo candado de fila del Bloque 2B, esa clase de bug desaparece por construcción, no por parche.

---

## 1. Alcance

### 1.1 Incluido

- Modelo `Customer` — población de clientes, **separada del `User` de staff** (ya fijado en el Bloque 1).
- Wallet como **ledger inmutable**: todo cambio de saldo es un movimiento tipado y permanente. El saldo cacheado se muta bajo `SELECT … FOR UPDATE` dentro de `prisma.$transaction`, reusando el patrón exacto de `StockLevel` ↔ `StockMovement` del Bloque 2.
- Contrato de wallet: `creditar` / `debitar` / `ajustar` / `revertir`, todo bajo candado de fila, con idempotencia por `reference`.
- Acreditación manual por staff (recargas en mostrador y carga de saldos históricos del Excel — ver §1.3).
- **Integración con el POS:** `STORE_CREDIT` como medio de pago en el checkout del Bloque 3 (débito atómico dentro de la misma transacción de la venta) y **reversa automática del débito al anular la venta**.
- Consulta de saldo e historial de movimientos por cliente.
- Auditoría completa (`AuditLog`) de cada operación: quién, qué, cuánto, sobre qué cliente, con qué motivo.
- Hook de expiración (campo `expira_en` por movimiento de crédito + parámetro en Settings). El **mecanismo de barrido** se difiere — ver §6 y D4-01.

### 1.2 Fuera de alcance (diferido, con razón)

| Tema | Por qué se difiere | Destino |
|---|---|---|
| **Sync del saldo con WordPress/Woo** | Meter un segundo escritor del saldo antes de que los sitios sean canales hijos reproduce el problema de doble-escritura que documentó la auditoría (V-006). Misma lógica que dejó Woo fuera del Bloque 3. | Bloque 5 |
| **Migración de saldos legacy** | **No existen saldos legacy a migrar.** El Excel es histórico congelado (decisión cerrada, §1.3). | — (no aplica) |
| **Recargas con pago real (Webpay/Mercado Pago)** | En el Bloque 4 una recarga la registra el staff como un crédito manual (efectivo en mostrador), consistente con el "pago confirmado simulado" que declara el ESTADO actual. | Bloque 6 |
| **Cashback / puntos de lealtad** | Capacidad sin consumidor hoy; construirla ahora viola "cambios quirúrgicos". **La puerta queda abierta sin costo:** es un valor nuevo en `WalletMovementType` (`CASHBACK`) más la regla que lo genera, sin migración ni cambio del contrato de débito. | Evaluación futura |
| **Login del cliente / endpoints públicos de saldo** | Todo el wallet es operado por staff autenticado. No se exponen endpoints públicos ni sin auth — esto cierra V-002 y V-005 de la auditoría simplemente por no existir. | — (no aplica) |
| **Transferencias de saldo entre clientes** | Sin caso de uso pedido. | Evaluación futura |

### 1.3 Decisión cerrada — el Excel es histórico congelado

Lo registrado en Excel **se mantiene en Excel** como referencia muerta. El wallet del Bloque 4 nace con **saldo cero para todos** y se llena solo con lo que se ingrese desde el ERP de aquí en adelante.

Implicancia operativa: cuando un cliente llegue diciendo que "tenía saldo en el Excel", el staff lo ingresa como una **acreditación manual normal** (un movimiento `CREDITO_MANUAL` con su `reference`, su motivo y su `performed_by` auditados). No es una migración automática — es carga manual caso a caso, indistinguible de cualquier otra recarga. El ledger la absorbe sin lógica especial.

---

## 2. Principio rector y mapeo a la auditoría

El Bloque 4 reusa, no reinventa, el patrón ya probado en el Bloque 2:

| Inventario (Bloque 2, construido) | Wallet (Bloque 4) |
|---|---|
| `StockLevel.cantidad` (saldo cacheado) | `WalletAccount.saldo` (saldo cacheado) |
| `StockMovement` (ledger inmutable) | `WalletMovement` (ledger inmutable) |
| `SELECT … FOR UPDATE` sobre la fila de stock | `SELECT … FOR UPDATE` sobre la fila del wallet |
| Validación de stock suficiente dentro del candado | Validación de saldo suficiente dentro del candado |
| Idempotencia (reserva no se duplica) | Idempotencia por `reference` (crédito/débito no se duplica) |

Cómo este bloque cierra cada hallazgo crítico de la auditoría OnplayWallet:

| Hallazgo auditoría | Causa raíz original | Cómo lo cierra el Bloque 4 |
|---|---|---|
| **V-001** — fallback silencioso → saldo fantasma | El POS debitaba local aunque el remoto fallara, sin abortar la venta | No hay remoto. El débito es local-autoritativo dentro de la transacción de la venta. Si falla, **la venta entera falla** — sin fallback silencioso (AC-4.09). |
| **V-006** — doble crédito (API + webhook en paralelo) | Dos mecanismos de sync escribían el mismo crédito | Un solo escritor (el ERP). Sin sync este bloque. Idempotencia por `reference` (AC-4.03). |
| **Race condition** de débito concurrente | Validación de saldo con valor leído antes del candado | `SELECT … FOR UPDATE` y validación **dentro** del candado (AC-4.04). |
| **R-004** — falta auditoría consolidada | Operaciones dispersas POS/Web sin un ledger único | `WalletMovement` con `saldo_antes`/`saldo_despues`/`origen`/`performed_by` es el ledger consolidado por diseño. |

**Invariante central del bloque:** para todo cliente, `WalletAccount.saldo == SUM(movimientos con signo)` y `saldo >= 0` siempre. Verificado en AC-4.10.

---

## 3. Modelo de datos

Tres modelos y un enum nuevos. Más dos cambios quirúrgicos sobre modelos del Bloque 3 (§3.4). Dinero en **CLP entero** (`Int`), sin decimales, consistente con el resto del sistema.

### 3.1 `Customer`

```prisma
model Customer {
  id          Int       @id @default(autoincrement())
  rut         String?   @unique           // identidad chilena; opcional pero único si existe
  nombre      String
  email       String?   @unique           // opcional pero único si existe
  telefono    String?
  activo      Boolean   @default(true)    // soft-disable; nunca borra saldo ni historial
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  wallet      WalletAccount?
  movimientos WalletMovement[]
  ventas      Sale[]                       // ventas asociadas a este cliente (opcional)

  @@index([nombre])
}
```

Identidad mínima: ver D4-03. Un `Customer` puede existir sin email ni rut (cliente de mostrador con solo nombre + teléfono), pero si trae rut o email, son únicos.

### 3.2 `WalletAccount`

Una cuenta por cliente. Tiene el **saldo cacheado**, que es lo que se bloquea con `FOR UPDATE`. Es cache, no la verdad: la verdad es la suma del ledger. Se crea perezosamente al primer movimiento, o junto con el `Customer` (ver D4-03).

```prisma
model WalletAccount {
  id          Int       @id @default(autoincrement())
  customerId  Int       @unique
  customer    Customer  @relation(fields: [customerId], references: [id])
  saldo       Int       @default(0)        // CLP entero, cacheado. Invariante: == suma del ledger, >= 0
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
}
```

### 3.3 `WalletMovement` (ledger inmutable)

Cada cambio de saldo es una fila aquí, **nunca se edita ni se borra**. Una corrección es un movimiento nuevo (`AJUSTE`), no una edición.

```prisma
model WalletMovement {
  id            Int                @id @default(autoincrement())
  customerId    Int
  customer      Customer           @relation(fields: [customerId], references: [id])
  tipo          WalletMovementType
  monto         Int                // CLP entero, SIEMPRE positivo. El signo lo da `tipo` (§3.5)
  saldoAntes    Int
  saldoDespues  Int
  reference     String   @unique   // idempotencia: misma reference => 409, no se duplica
  origen        String             // POS_VENTA | MANUAL | ANULACION | AJUSTE | EXPIRACION
  motivo        String?            // texto libre del operador (obligatorio en AJUSTE)
  expiraEn      DateTime?          // solo créditos; null = no expira. Hook de §6
  saleId        Int?               // FK a Sale cuando el movimiento viene del POS
  sale          Sale?              @relation(fields: [saleId], references: [id])
  performedBy   Int                // userId del staff que ejecutó (de la sesión)
  createdAt     DateTime @default(now())

  @@index([customerId, createdAt])
  @@index([reference])
  @@index([expiraEn])
}
```

### 3.4 Cambios quirúrgicos sobre el Bloque 3

Dos cambios mínimos, ambos aditivos (no rompen nada existente):

1. **`PaymentMethod` += `STORE_CREDIT`.** El enum del Bloque 3 hoy tiene los medios de pago reales (efectivo/débito/crédito/transferencia). Se agrega `STORE_CREDIT`. **Esto es una migración de enum** — ver §10.
2. **`Payment.walletMovementId` (nullable, FK a `WalletMovement`).** Cuando una línea de pago es `STORE_CREDIT`, apunta al movimiento de débito que la respalda. Para los demás medios queda `null`. Da trazabilidad 1:1 pago↔movimiento.

```prisma
// en model Payment (Bloque 3), se agrega:
  walletMovementId Int?            @unique
  walletMovement   WalletMovement? @relation(fields: [walletMovementId], references: [id])
```

### 3.5 `WalletMovementType` (enum)

```prisma
enum WalletMovementType {
  CREDITO_MANUAL   // + recarga/carga histórica registrada por staff
  DEBITO_VENTA     // - pago de una venta POS con store credit
  REVERSA_VENTA    // + devolución de saldo al anular una venta
  AJUSTE           // ± corrección manual (admin + PIN). El signo lo decide el operador
  EXPIRACION       // - vencimiento de crédito (hook §6, barrido diferido)
  // CASHBACK       <- punto de extensión futuro (Bloque N). No se implementa ahora.
}
```

Signo por tipo (para la suma del invariante): `CREDITO_MANUAL`, `REVERSA_VENTA` → **suman**. `DEBITO_VENTA`, `EXPIRACION` → **restan**. `AJUSTE` → suma o resta según lo indique el operador (campo explícito en el request).

---

## 4. Contrato del wallet (servicio)

Todas las funciones de mutación viven en `services/wallet.js`, corren dentro de `prisma.$transaction`, y **toman el candado de fila sobre `WalletAccount` antes de leer el saldo**. Misma forma que el contrato de inventario del 2B.

```
creditar({ customerId, monto, origen, reference, motivo?, expiraEn?, performedBy }) -> WalletMovement
debitar ({ customerId, monto, origen, reference, saleId?, performedBy }, tx?)        -> WalletMovement
revertir({ saleId, performedBy }, tx?)                                               -> WalletMovement | null
ajustar ({ customerId, monto, signo, motivo, reference, performedBy })               -> WalletMovement
saldoDe (customerId)                                                                  -> Int
historial(customerId, { page, size })                                                 -> WalletMovement[]
```

### 4.1 Esqueleto de `debitar` (patrón candado, idéntico al 2B)

```js
// Acepta un `tx` externo para poder correr DENTRO de la transacción del checkout.
async function debitar({ customerId, monto, origen, reference, saleId, performedBy }, tx) {
  const run = async (db) => {
    // 0) Idempotencia: misma reference => no se duplica
    const dup = await db.walletMovement.findUnique({ where: { reference } });
    if (dup) { const e = new Error('DUPLICATE_REFERENCE'); e.code = 409; throw e; }

    // 1) Candado de fila sobre la cuenta
    const [acc] = await db.$queryRaw`
      SELECT id, saldo FROM WalletAccount WHERE customerId = ${customerId} FOR UPDATE`;
    if (!acc) { const e = new Error('NO_WALLET'); e.code = 404; throw e; }

    // 2) Validación de saldo DENTRO del candado (fix de la race condition)
    if (acc.saldo < monto) { const e = new Error('INSUFFICIENT_BALANCE'); e.code = 422; throw e; }

    const saldoAntes = acc.saldo;
    const saldoDespues = saldoAntes - monto;

    // 3) Mutar cache + escribir ledger, atómico
    await db.walletAccount.update({ where: { id: acc.id }, data: { saldo: saldoDespues } });
    return db.walletMovement.create({ data: {
      customerId, tipo: 'DEBITO_VENTA', monto, saldoAntes, saldoDespues,
      reference, origen, saleId, performedBy,
    }});
  };
  return tx ? run(tx) : prisma.$transaction(run);
}
```

`creditar` y `ajustar` son la imagen espejo (validan `monto > 0`, no requieren saldo previo). `revertir(saleId)` busca el `DEBITO_VENTA` con `saleId` dado, y si existe y no fue ya revertido, crea un `REVERSA_VENTA` por el mismo monto con `reference = REVERSA-{saleId}` (idempotente: re-anular no duplica el reembolso).

---

## 5. Integración con el POS (Bloque 3)

Aquí el wallet estrena su consumidor real. Dos puntos de cableado, ambos **dentro de transacciones que ya existen y ya son atómicas** en el Bloque 3.

### 5.1 Checkout con `STORE_CREDIT`

El checkout del Bloque 3 ya confirma reservas → `VENDIDA`, crea la `Sale` y registra los `Payment` en una sola `$transaction`. Se agrega: por cada `Payment` con método `STORE_CREDIT`, llamar `debitar(...)` **pasándole el `tx` de la transacción del checkout**, con `reference = POS-DEBITO-{saleId}` y `origen = 'POS_VENTA'`. El `Payment.walletMovementId` queda apuntando al movimiento creado.

Reglas duras:
- El candado del wallet se toma **después** de confirmar el inventario, para mantener un orden de adquisición de candados consistente (inventario → wallet) y evitar deadlocks entre cajas concurrentes.
- Si `debitar` lanza `INSUFFICIENT_BALANCE`, **la transacción del checkout completa hace rollback**: no hay venta, no se descuenta stock, no se cobra. Sin fallback silencioso (cierra V-001).
- Pago mixto: `STORE_CREDIT` puede combinarse con efectivo/débito/etc. La suma de los `Payment` debe igualar el total de la venta (validación que el Bloque 3 ya hace); el sistema solo agrega que el monto en `STORE_CREDIT` ≤ saldo del cliente. El operador decide cuánto pone en cada medio (D4-04).

### 5.2 Anulación de venta

El Bloque 3 ya tiene `POST /ventas/:id/anular` (admin + PIN propio), que revierte inventario (`VENDIDA → DISPONIBLE`) dentro de su transacción. Se agrega: si la venta anulada tenía un `Payment` `STORE_CREDIT`, llamar `revertir({ saleId }, tx)` dentro de esa misma transacción → genera `REVERSA_VENTA` y devuelve el saldo. Idempotente por `reference = REVERSA-{saleId}`.

---

## 6. Expiración de saldo (hook presente, barrido diferido)

Decisión de diseño fiel a cómo el Bloque 2 trató el TTL (mecanismo en el bloque, valor afinado después):

- **Presente ahora (costo cero):** el campo `WalletMovement.expiraEn` y la Setting `wallet_credito_vigencia_dias`. Al crear un `CREDITO_MANUAL`, si `wallet_credito_vigencia_dias > 0`, se calcula `expiraEn = now + N días`. El campo existe desde el día uno, así que activar expiración después **no requiere migración**.
- **Diferido (B3 — no construir lo que nadie usa):** el **proceso de barrido** que vence créditos y la **lógica de consumo FIFO por lote** que ese barrido necesita. Default `wallet_credito_vigencia_dias = 0` (nunca expira) ⇒ el barrido sería un no-op. Se construye cuando la tienda decida activar vigencia > 0. Esto es D4-01 — si quieres expiración funcional desde ya, se sube al alcance de este bloque y se diseña el modelo de lotes.

Razón de no construir el FIFO ahora: un barrido correcto sobre un ledger inmutable con débitos parciales exige rastrear consumo por lote de crédito (cada crédito con su propio remanente y fecha). Eso es maquinaria real; sin la tienda usando expiración, es complejidad sin consumidor.

---

## 7. API

Base `/api`. Auth `Bearer <token>` en todo (no hay endpoints públicos — por diseño). Matriz de roles del ESTADO: `SUPER_ADMIN`/`STORE_ADMIN` = todo · `SALES_ASSISTANT` = opera · `ACCOUNTANT` = solo lectura.

### 7.1 Clientes — `/api/customers`

| Método | Ruta | Acceso |
|---|---|---|
| POST | `/customers` | operar (vendedor/admin) — alta en mostrador |
| GET | `/customers` · `/customers/:id` | autenticado |
| GET | `/customers?q=` | autenticado — búsqueda por nombre/rut/email |
| PATCH | `/customers/:id` | admin (datos) / operar no edita rut |
| PATCH | `/customers/:id/activo` | admin (soft-disable) |

### 7.2 Wallet — `/api/wallet`

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/wallet/:customerId` | lectura (+contador) — saldo actual |
| GET | `/wallet/:customerId/movimientos` | lectura (+contador) — historial paginado |
| POST | `/wallet/:customerId/creditar` | operar + **PIN propio siempre**; PIN supervisor si `monto > umbral` (D4-02) |
| POST | `/wallet/:customerId/ajustar` | **admin + PIN propio**; motivo obligatorio |

No hay endpoint de **débito manual**: el débito ocurre solo vía checkout del POS. Esto evita una ruta paralela de gasto que duplicaría lógica (lección D-002 de la auditoría).

---

## 8. Controles de seguridad y rol

- Todo bajo `requireAuth` + `requireSession`. El `performedBy` sale de la sesión, nunca del body.
- **Acreditar crea dinero** ⇒ siempre PIN propio del operador, y PIN de supervisor sobre `wallet_acreditacion_pin_supervisor_umbral` (mismo patrón que el descuento del Bloque 3).
- **Ajustar** ⇒ admin + PIN + motivo obligatorio (es la única vía de corregir y debe doler un poco).
- `SALES_ASSISTANT` puede crear clientes y acreditar (con PIN), pero **no ajustar ni anular ventas** (anular ya es admin en el Bloque 3).
- `ACCOUNTANT` ⇒ solo `GET` de saldo e historial.
- Cada operación escribe en `AuditLog` (acción, customerId, monto, reference, performedBy).

---

## 9. Settings nuevos

Dos claves nuevas en la tabla `Setting` (editables en runtime, como el resto):

| Clave | Tipo | Default | Significado |
|---|---|---|---|
| `wallet_credito_vigencia_dias` | int | `0` | Días hasta expirar un crédito. `0` = nunca expira (barrido inactivo). |
| `wallet_acreditacion_pin_supervisor_umbral` | int (CLP) | `50000` | Sobre este monto, una acreditación manual exige PIN de supervisor. |

---

## 10. Criterios de aceptación

Verificables en backend contra MySQL real, mismo estándar que los 62 tests existentes.

| ID | Criterio |
|---|---|
| AC-4.01 | Crear `Customer` con solo nombre+teléfono funciona; con rut/email duplicado → 409. |
| AC-4.02 | `creditar` aumenta el saldo, crea un `WalletMovement` con `saldoAntes`/`saldoDespues` correctos y el `reference` dado. |
| AC-4.03 | `creditar`/`debitar` con un `reference` ya usado → 409 y **el saldo no cambia** (idempotencia). |
| AC-4.04 | Dos `debitar` concurrentes sobre la última fracción de saldo: uno gana, el otro recibe `INSUFFICIENT_BALANCE`; **el saldo nunca queda negativo**. |
| AC-4.05 | `debitar` con `monto > saldo` → 422, saldo intacto, sin movimiento. |
| AC-4.06 | `ajustar` con signo negativo que dejaría saldo < 0 → rechazado. |
| AC-4.07 | Checkout con `STORE_CREDIT` suficiente: descuenta saldo, crea `DEBITO_VENTA`, y `Payment.walletMovementId` apunta a ese movimiento. |
| AC-4.08 | Checkout con pago mixto (`STORE_CREDIT` + efectivo) cuya suma = total: ok; débito solo por la parte de store credit. |
| AC-4.09 | Checkout con `STORE_CREDIT` > saldo: **toda la venta hace rollback** — sin venta, sin descuento de stock, sin movimiento de wallet (cierra V-001). |
| AC-4.10 | Invariante: tras cualquier secuencia de operaciones, `WalletAccount.saldo == SUM(movimientos con signo)` y `>= 0`. |
| AC-4.11 | Anular una venta pagada con `STORE_CREDIT` crea `REVERSA_VENTA` y restaura el saldo exacto. |
| AC-4.12 | Anular dos veces la misma venta no duplica el reembolso (idempotencia por `REVERSA-{saleId}`). |
| AC-4.13 | `SALES_ASSISTANT` no puede `ajustar` (403); `ACCOUNTANT` no puede `creditar` (403). |
| AC-4.14 | Acreditación sobre el umbral sin PIN de supervisor → rechazada; con PIN → ok. |
| AC-4.15 | Toda operación de mutación deja una fila en `AuditLog` con el `performedBy` de la sesión. |

---

## 11. Decisiones a ratificar (antes de codear)

| ID | Decisión | Recomendación |
|---|---|---|
| **D4-01** | Expiración: ¿solo hook (`expiraEn` + Setting, barrido diferido) o barrido FIFO funcional ya? | **Solo hook.** Default vigencia = 0. El FIFO se construye cuando la tienda active expiración (B3). |
| **D4-02** | Acreditación manual: control de acceso. | **operar + PIN propio siempre; PIN supervisor sobre umbral.** Crear dinero nunca es libre. |
| **D4-03** | Identidad mínima del `Customer` y creación del `WalletAccount`. | **rut O email opcionales pero únicos; nombre obligatorio.** `WalletAccount` se crea junto con el `Customer` (saldo 0), no perezosamente — simplifica el candado. |
| **D4-04** | Pago mixto: ¿el sistema reparte o lo decide el operador? | **Lo decide el operador.** El sistema solo valida suma = total y store credit ≤ saldo. |
| **D4-05** | ¿Saldo negativo alguna vez? | **Nunca.** Invariante duro (AC-4.06, AC-4.10). |
| **D4-06** | ¿`STORE_CREDIT` puede pagar el 100% de una venta, o exige un mínimo en otro medio? | **Puede pagar el 100%.** No hay razón de negocio para forzar otro medio. |

---

## 12. Bloqueos previos al código

Verificar contra el repo real antes de que Claude Code escriba una línea (igual que el §13 del Bloque 3):

1. **`PaymentMethod` no tiene `STORE_CREDIT` hoy** → agregarlo es una migración de enum. Confirmar y generar la migración como primer paso de 4B.
2. **`Payment` necesita `walletMovementId` nullable** → migración aditiva. Confirmar que el checkout del Bloque 3 puede escribir ese campo sin romper sus 22 tests.
3. **El `anular` del Bloque 3 debe exponer un punto dentro de su `$transaction`** para encajar `revertir()`. Confirmar que la transacción de anulación es accesible/extensible sin reescribirla.
4. **El checkout del Bloque 3 debe poder recibir el `tx`** y pasarlo a `debitar()`. Confirmar que la firma del checkout permite inyectar la operación de wallet dentro de su transacción (si hoy es cerrada, es un refactor quirúrgico, no una reescritura).

Si alguno de estos cuatro no se cumple tal como está, se resuelve como cambio quirúrgico mínimo **dentro de 4B**, documentado, sin tocar la lógica ya verde del Bloque 3.

---

## 13. Plan de sub-tandas

Cada una cierra contra su parte de los criterios antes de pasar a la siguiente (B1).

| Sub-tanda | Alcance | Verificable con |
|---|---|---|
| **4A — Motor de wallet** | `Customer`, `WalletAccount`, `WalletMovement`, enum; contrato `creditar/debitar/ajustar/revertir/saldoDe/historial` bajo candado; endpoints `/customers` y `/wallet`. **Sin tocar el POS.** | AC-4.01 a 4.06, 4.10, 4.13, 4.14, 4.15. Se verifica solo, sin depender del Bloque 3. |
| **4B — Integración POS** | Migración `PaymentMethod += STORE_CREDIT` + `Payment.walletMovementId`; `STORE_CREDIT` en checkout; reversa en anulación. | AC-4.07, 4.08, 4.09, 4.11, 4.12. Más: re-correr los 22 tests del Bloque 3 en verde (no regresión). |
| **4C — Expiración** *(condicional a D4-01)* | Solo si se decide construir el barrido FIFO ahora. Si no, no existe. | Criterios de expiración a definir si se activa. |

---

*Fin del documento. BORRADOR — ratificar §11 antes de bajar el kit a Claude Code.*
