# Bloque 3 — Canal POS (Punto de Venta Físico)

> **Proyecto:** onplay-erp · **Dominio:** erp.onplaygames.cl
> **Estado del documento:** BORRADOR para revisión — contiene decisiones a confirmar
> **Depende de:** Bloque 1 (auth/sesión) y Bloque 2 (catálogo + autoridad de inventario), ambos especificados y con decisiones bloqueadas.
> **Modelo arquitectónico:** Model A — el ERP es la única fuente de verdad. El POS es un **canal hijo** que consume el motor de inventario; no tiene su propia copia de stock.

---

## 0. Propósito

El Bloque 3 estrena el contrato `reservar → confirmar → liberar` del motor de inventario (Bloque 2) con el primer canal real: las ventas en mostrador de la tienda física.

Objetivo de negocio directo: **cada venta presencial mueve stock en la autoridad de inmediato**, eliminando la desincronización por el lado físico. El stock que se vende en mostrador deja de estar disponible para cualquier otro canal en el mismo instante en que se confirma la venta.

El Bloque 3 **no** resuelve el overselling web por sí solo (eso llega cuando WooCommerce lea la autoridad, después del reemplazo de onplay-manager en el Bloque 5). Resuelve la mitad física del problema y deja el motor de inventario validado contra criterios de aceptación reales.

---

## 1. Alcance

### 1.1 Incluido

- Sesión de caja (apertura/cierre con cuadre esperado vs. contado).
- Carrito de venta como conjunto de **reservas vivas** del Bloque 2 (con TTL).
- Checkout: confirmación atómica de reservas → `VENDIDA`, registro de venta y pagos.
- Pagos: efectivo, débito, crédito, transferencia, y **pagos mixtos**.
- Descuentos de línea y de total, con control por rol y revalidación PIN sobre umbral.
- Anulación de venta **dentro de la misma sesión de caja** (reversa de inventario y pago).
- Multi-terminal (varias cajas concurrentes, p. ej. mostrador + caja de eventos).
- Auditoría completa de cada operación de POS (usuario, terminal, timestamp, motivo).

### 1.2 Fuera de alcance (diferido, con razón)

| Tema | Por qué se difiere | Destino |
|---|---|---|
| **Store credit / wallet como medio de pago** | El wallet del cliente está diferido al Bloque 4. El método `STORE_CREDIT` se reserva en el modelo pero queda deshabilitado. | Bloque 4 |
| **Devoluciones / cambios de venta ya cerrada (re-stock)** | Es un flujo distinto al de la anulación intra-sesión: requiere reglas de re-ingreso de inventario, ventana de tiempo, condición del producto y, eventualmente, reverso contable. Meterlo aquí infla el bloque. | Sub-bloque posterior o bloque propio |
| **Contabilidad de partida doble (asientos por venta)** | El rol `contador` y la contabilidad son su propio dominio. El POS deja la venta registrada de forma limpia; la contabilidad la consume después. Acoplar asientos al POS fue parte de la complejidad de OnplayPOSv2. | Bloque contable posterior |
| **Boleta/factura electrónica (SII)** | Emisión de documento tributario es una integración externa pesada y legalmente sensible. El POS registra la venta interna; la emisión fiscal se resuelve aparte. | Decisión externa / bloque propio |
| **Compra de cartas a clientes (trade-in, precio ×400)** | Es adquisición de inventario, no venta. Pertenece a entrada de costo/compras (Bloque 2D y compras). | Compras |
| **Sincronización con WooCommerce desde el POS** | onplay-manager sigue escribiendo stock a Woo hasta el Bloque 5. Un segundo escritor de stock reintroduce la condición de carrera de doble-escritura que la auditoría POS↔Wallet ya documentó (V-006). | Bloque 5 |
| **Modo offline / venta degradada** | Ver Decisión D3-01. Una venta autoritativa exige el ERP en línea. | No se implementa |

---

## 2. Decisiones heredadas que el Bloque 3 consume (ya bloqueadas)

Del **Bloque 1**:
- JWT en todos los endpoints + audit logging.
- Cuatro roles: `super_admin_sistema`, `administrador_tienda`, `contador`, `asistente_de_ventas`.
- PIN = **revalidación en sesión** para acciones sensibles (no es método de login).
- Bloqueo de pantalla por inactividad a los 10 min (no termina sesión).

Del **Bloque 2**:
- Máquina de estados de inventario: `DISPONIBLE → RESERVADA → VENDIDA`.
- Contrato `reservar → confirmar → liberar` bajo **bloqueo de fila** y **expiración por TTL**.
- Doble tracking: **por unidad** para singles, **por cantidad** para sellado/snacks/accesorios.
- Tabla `Settings` en BD para todos los parámetros configurables (multiplicador, FX, redondeo, TTL).
- Precio de venta = referencia USD × 1.000 CLP (multiplicador y redondeo configurables en Settings).
- Formato de SKU: `SET-número-condición-idioma` (+ sufijo Foil).

El Bloque 3 **no redefine** ninguna de estas reglas. Lee precio desde lo que el Bloque 2 ya calcula; reserva/confirma/libera a través del contrato existente; valida PIN con el mecanismo del Bloque 1.

---

## 3. ⚠️ Cruce entre bloques que requiere decisión (lo más importante de revisar)

La anulación de una venta dentro de la sesión necesita devolver inventario confirmado a disponible: una transición **`VENDIDA → DISPONIBLE`**.

El motor del Bloque 2 está definido **hacia adelante** (`DISPONIBLE → RESERVADA → VENDIDA`). No tiene reversa. Esto es una contradicción potencial entre bloques, no un detalle del Bloque 3.

Opciones:

- **Opción A (recomendada):** Extender el contrato del Bloque 2 con una transición de reversa **acotada y auditada** `VENDIDA → DISPONIBLE`, usable **solo** por la operación "anular venta" del Bloque 3 y bajo el mismo bloqueo de fila. Emite un movimiento de inventario compensatorio (no borra el original).
- **Opción B:** No tocar el Bloque 2. Modelar la anulación como una **nueva entrada de inventario** (un movimiento de ingreso independiente) que crea unidades/cantidad nuevas. Más limpio en lo conceptual pero rompe la trazabilidad 1:1 entre la unidad vendida y la unidad re-disponibilizada (problemático para singles, donde la unidad es física e identificable).

**Recomendación: Opción A**, limitada a anulación intra-sesión y con movimiento compensatorio. Para singles preserva la identidad de la unidad física; para sellado revierte la cantidad. Requiere agregar la transición de reversa al spec del Bloque 2 (cambio menor, pero hay que ratificarlo ahí para no dejar los dos specs en desacuerdo).

---

## 4. Decisiones del Bloque 3 a confirmar

| ID | Decisión | Recomendación | Razón |
|---|---|---|---|
| D3-01 | ¿Venta offline? | **No. POS solo en línea.** | Una venta autoritativa requiere reservar en el ERP. Vender offline reintroduce overselling y rompe el Model A. |
| D3-02 | ¿Devoluciones de venta cerrada? | **Diferido.** En Bloque 3 solo anulación intra-sesión. | Mantiene el bloque acotado (ver §1.2). |
| D3-03 | ¿Asientos contables en el POS? | **Fuera de alcance.** | La contabilidad es bloque aparte. |
| D3-04 | ¿Boleta electrónica? | **Fuera de alcance.** | Integración fiscal externa. |
| D3-05 | Descuentos | Línea + total, por rol, **PIN sobre umbral** (Settings). | Control de pérdida; auditable. |
| D3-06 | Multi-terminal | **Sí.** Una sesión de caja `ABIERTA` por terminal a la vez. | Mostrador + eventos pueden operar en paralelo. |
| D3-07 | Cliente en la venta | **Opcional, solo informativo.** Sin operaciones de wallet. | Wallet es Bloque 4. |
| D3-08 | Reversa de inventario para anular | **Opción A** del §3. | Preserva identidad de unidad física. |
| D3-09 | Medios de pago | `CASH`, `DEBIT`, `CREDIT`, `TRANSFER` + mixto. `STORE_CREDIT` reservado, deshabilitado. | Wallet diferido. |
| D3-10 | Moneda | CLP **entero** (sin decimales). Redondeo según Settings del Bloque 2. | El peso chileno no tiene centavos; evita errores de coma flotante. |

---

## 5. Modelo de datos (nuevo en Bloque 3)

Todos los montos en CLP entero. Decimal/entero, **nunca** float.

### 5.1 `Terminal` (punto de venta físico)
| Campo | Tipo | Nota |
|---|---|---|
| id | PK | |
| nombre | string | "Mostrador", "Caja Eventos" |
| activo | bool | |

### 5.2 `SesionCaja`
| Campo | Tipo | Nota |
|---|---|---|
| id | PK | |
| terminal_id | FK Terminal | |
| usuario_apertura_id | FK User | |
| fondo_apertura | int CLP | efectivo inicial declarado |
| abierta_at | datetime | |
| estado | enum | `ABIERTA` \| `CERRADA` |
| cerrada_at | datetime? | |
| usuario_cierre_id | FK User? | |
| monto_esperado | int CLP? | calculado al cerrar |
| monto_contado | int CLP? | declarado al cerrar |
| diferencia | int CLP? | contado − esperado |
| notas | text? | |

**Invariante:** como máximo **una** `SesionCaja` con estado `ABIERTA` por `terminal_id` (constraint a nivel de BD o guard transaccional).

### 5.3 `Venta`
| Campo | Tipo | Nota |
|---|---|---|
| id | PK | |
| folio | int único | correlativo **sin huecos** por tienda, generado bajo lock |
| sesion_caja_id | FK SesionCaja | |
| usuario_id | FK User | quien opera |
| cliente_id | FK Customer? | opcional, informativo |
| estado | enum | `BORRADOR` \| `COMPLETADA` \| `ANULADA` \| `ABANDONADA` |
| subtotal | int CLP | suma de líneas antes de descuento de total |
| descuento_total | int CLP | |
| total | int CLP | a cobrar |
| created_at | datetime | |
| completed_at | datetime? | |
| anulada_at | datetime? | |
| anulada_por_id | FK User? | |
| motivo_anulacion | text? | |

### 5.4 `LineaVenta`
| Campo | Tipo | Nota |
|---|---|---|
| id | PK | |
| venta_id | FK Venta | |
| reserva_id | FK Reserva (Bloque 2) | la reserva viva que respalda esta línea |
| producto_id | FK Product | |
| unidad_id | FK UnidadInventario? | solo singles (tracking por unidad) |
| sku | string | snapshot |
| descripcion | string | snapshot |
| tipo_tracking | enum | `UNIDAD` \| `CANTIDAD` |
| cantidad | int | singles: 1 por unidad |
| precio_unitario | int CLP | snapshot del precio al momento de agregar |
| descuento_linea | int CLP | |
| total_linea | int CLP | |

> **Snapshot de precio:** `precio_unitario` se congela al agregar la línea. Si Settings cambia el multiplicador a mitad de una venta, el carrito en curso mantiene su precio.

### 5.5 `DetallePago`
| Campo | Tipo | Nota |
|---|---|---|
| id | PK | |
| venta_id | FK Venta | |
| metodo | enum | `CASH` \| `DEBIT` \| `CREDIT` \| `TRANSFER` (\| `STORE_CREDIT` reservado) |
| monto | int CLP | monto **aplicado** a la venta (no el recibido) |
| referencia | string? | últimos dígitos, nro. transferencia, etc. |
| created_at | datetime | |

> **Efectivo y vuelto:** el cajero puede recibir más efectivo que el saldo a pagar. El `monto` registrado en `DetallePago(CASH)` es el aplicado a la venta (= neto al cajón). El vuelto es cálculo de UI y **no** se persiste como pago. Esto mantiene el cuadre de caja simple: el cajón sube exactamente en la suma de pagos `CASH` de la sesión.

### 5.6 `AuditoriaPOS` (o reuso del audit log del Bloque 1)
Registra: `abrir_caja`, `cerrar_caja`, `crear_venta`, `agregar_linea`, `quitar_linea`, `checkout`, `anular_venta`, `descuento_sobre_umbral`, `no_sale` (abrir cajón sin venta). Cada entrada: usuario, terminal, sesión, venta (si aplica), timestamp, payload mínimo, y si requirió PIN, marca de revalidación.

---

## 6. Máquina de estados de la `Venta`

```
                      agregar/quitar líneas (reservas vivas)
                                   │
        crear ─────────────► BORRADOR ───────────────► COMPLETADA
                                │  │  checkout (pago = total,                │
                                │  │  confirmar reservas → VENDIDA)          │
              TTL expira        │  │                                         │ anular_venta
        (reservas se liberan)   │  │                              (intra-sesión, rol+PIN,
                                ▼  ▼                               reversa VENDIDA→DISPONIBLE)
                          ABANDONADA                                        ▼
                                                                        ANULADA
```

Reglas de transición:

- **BORRADOR → COMPLETADA:** requiere que la suma de `DetallePago.monto` iguale exactamente `total`. La confirmación de **todas** las reservas a `VENDIDA` ocurre en **una sola transacción**. Si cualquier confirmación falla, se hace rollback total: no se cobra, no se mueve stock, la venta sigue en `BORRADOR`.
- **BORRADOR → ABANDONADA:** si el TTL del carrito vence sin checkout, el Bloque 2 libera las reservas (vuelven a `DISPONIBLE`) y la venta queda `ABANDONADA` (se conserva para auditoría; no se borra).
- **COMPLETADA → ANULADA:** solo mientras la `SesionCaja` esté `ABIERTA`. Revierte inventario (Opción A del §3) y los pagos, bajo rol autorizado + PIN. Una vez cerrada la caja, la anulación ya no aplica (sería devolución → diferido).

`ANULADA` y `ABANDONADA` son terminales.

---

## 7. Integración con el motor de inventario (Bloque 2)

| Acción POS | Operación Bloque 2 | Tracking por unidad (singles) | Tracking por cantidad (sellado/snacks) |
|---|---|---|---|
| Agregar línea al carrito | `reservar` | reserva 1 unidad específica → `RESERVADA` | reserva N del pool → `RESERVADA` |
| Quitar línea | `liberar` | unidad → `DISPONIBLE` | N → `DISPONIBLE` |
| TTL del carrito vence | `liberar` (auto) | igual | igual |
| Checkout exitoso | `confirmar` | unidad → `VENDIDA` | N → `VENDIDA` |
| Anular venta (intra-sesión) | reversa (D3-08, Op. A) | unidad → `DISPONIBLE` + movimiento compensatorio | N → `DISPONIBLE` + movimiento compensatorio |

El POS **nunca** escribe stock directamente. Toda mutación de inventario pasa por el contrato del Bloque 2 con su bloqueo de fila.

---

## 8. Reglas de negocio

1. **Precio:** se lee del precio de venta calculado por el Bloque 2 (USD × multiplicador, redondeo Settings). El POS no recalcula con su propia fórmula.
2. **Snapshot:** `precio_unitario`, `sku` y `descripcion` se congelan al agregar la línea.
3. **Descuentos:** de línea y de total. Por debajo del umbral (Settings) los aplica el `asistente_de_ventas`. Sobre el umbral requieren rol `administrador_tienda`/`super_admin_sistema` **o** revalidación PIN de supervisor. Todo descuento sobre umbral se audita.
4. **Pago exacto:** Σ `DetallePago.monto` = `total`. No se permite cobrar de más ni de menos (el exceso de efectivo es vuelto, no pago).
5. **Pago mixto:** múltiples `DetallePago` de distintos métodos en una venta.
6. **Folio:** correlativo sin huecos por tienda, generado bajo lock dentro de la transacción de checkout.
7. **Una caja abierta por terminal:** no se puede abrir una segunda sesión en un terminal con sesión `ABIERTA`.
8. **Cuadre:** `monto_esperado = fondo_apertura + Σ pagos CASH de la sesión`; `diferencia = monto_contado − monto_esperado`.
9. **Moneda:** CLP entero en todo el flujo.

---

## 9. Contratos de API

Todos bajo JWT (Bloque 1) + guard de rol + auditoría. Prefijo `/api/pos`.

| Método | Ruta | Rol mínimo | PIN | Descripción |
|---|---|---|---|---|
| POST | `/sesiones` | asistente | — | Abrir caja (terminal + fondo) |
| GET | `/sesiones/activa` | asistente | — | Sesión activa del terminal/usuario |
| POST | `/sesiones/:id/cerrar` | asistente | sí, si diferencia > umbral | Cerrar caja con monto contado |
| POST | `/sesiones/:id/no-sale` | asistente | sí | Abrir cajón sin venta (auditado) |
| POST | `/ventas` | asistente | — | Crear venta `BORRADOR` |
| POST | `/ventas/:id/lineas` | asistente | — | Agregar línea (reserva) |
| DELETE | `/ventas/:id/lineas/:lineaId` | asistente | — | Quitar línea (libera) |
| PATCH | `/ventas/:id/descuento` | asistente | sí, sobre umbral | Descuento línea/total |
| POST | `/ventas/:id/checkout` | asistente | — | Pagos + confirmar → `COMPLETADA` |
| POST | `/ventas/:id/anular` | administrador_tienda | sí | Anular intra-sesión |
| GET | `/ventas/:id` | asistente (contador: lectura) | — | Detalle |
| GET | `/ventas` | asistente (contador: lectura) | — | Listado con filtros |

Matriz de roles:
- `asistente_de_ventas`: operar su caja, vender, checkout, descuento bajo umbral. Anular requiere autorización (rol superior o PIN supervisor).
- `administrador_tienda`: todo POS + anular + descuento sin límite + reportes de caja.
- `contador`: **solo lectura** de ventas y cajas. No opera.
- `super_admin_sistema`: todo.

---

## 10. Concurrencia y seguridad

- **Reservas y unidades:** se apoyan en el bloqueo de fila del Bloque 2. Dos terminales no pueden reservar la misma unidad single; la segunda recibe conflicto explícito.
- **Checkout atómico:** `prisma.$transaction` con timeout (referencia OnplayPOSv2: 15 s) envolviendo confirmación de reservas + creación de venta + líneas + pagos + folio. Fallo en cualquier paso ⇒ rollback total.
- **Folio bajo lock:** generación del correlativo dentro de la transacción para evitar duplicados/huecos en concurrencia.
- **Sesión única por terminal:** garantizada por constraint o guard transaccional.
- **PIN:** revalidación (Bloque 1, PIN hasheado) en anular, descuento sobre umbral, no-sale, y cierre con diferencia sobre umbral.

### Riesgos heredados de las auditorías y cómo se mitigan
- **Race condition en débito (auditoría POS↔Wallet, "Conc.")** → resuelto de raíz: toda mutación pasa por el bloqueo de fila del Bloque 2; checkout atómico.
- **Doble sincronización (V-006)** → no aplica en Bloque 3 (sin sync externo). Principio anotado para Bloque 5.
- **PIN en texto plano (V-004)** → el Bloque 1 ya hashea el PIN; el POS usa su revalidación.
- **Falta de trazabilidad consolidada (R-004)** → `AuditoriaPOS` cubre todas las operaciones.

---

## 11. Criterios de aceptación

> El Bloque 3 no avanza al siguiente bloque hasta que **todos** estos pasen.

**Inventario / carrito**
- AC-3.01 — Agregar un single al carrito crea exactamente una reserva `RESERVADA` sobre esa unidad; deja de estar `DISPONIBLE` para cualquier otro terminal.
- AC-3.02 — Agregar un producto por cantidad reserva N del pool; el disponible baja en N.
- AC-3.03 — Quitar una línea libera su reserva y restituye el stock a `DISPONIBLE`.
- AC-3.04 — Dos terminales intentando reservar la misma unidad single: solo uno lo logra; el otro recibe conflicto.
- AC-3.05 — Un carrito sin checkout expira al cumplirse el TTL (Settings) y todas sus reservas vuelven a `DISPONIBLE` automáticamente; la venta queda `ABANDONADA`.

**Checkout / pago**
- AC-3.06 — Checkout con Σ pagos = total confirma **todas** las reservas a `VENDIDA` en una sola transacción.
- AC-3.07 — Si la confirmación de cualquier reserva falla en el checkout, no se cobra nada y la venta permanece en `BORRADOR` (rollback total verificable).
- AC-3.08 — Pago mixto: la suma de `DetallePago` debe igualar el total; el sistema rechaza montos que no cuadran.
- AC-3.09 — Exceso de efectivo se calcula como vuelto y no se persiste como pago; el neto al cajón = Σ pagos `CASH`.
- AC-3.10 — El folio es correlativo, único y sin huecos incluso bajo checkouts concurrentes.
- AC-3.11 — `precio_unitario` de una línea no cambia aunque Settings cambie el multiplicador después de agregarla.

**Caja**
- AC-3.12 — No se puede abrir una segunda `SesionCaja` `ABIERTA` en un terminal que ya tiene una.
- AC-3.13 — Al cerrar, `monto_esperado = fondo_apertura + Σ pagos CASH de la sesión`, y `diferencia = contado − esperado`.
- AC-3.14 — Cierre con diferencia sobre umbral exige revalidación PIN.

**Anulación**
- AC-3.15 — Anular una venta `COMPLETADA` dentro de la sesión revierte inventario (unidad/cantidad → `DISPONIBLE`) con movimiento compensatorio y revierte los pagos.
- AC-3.16 — La anulación exige rol autorizado + PIN y queda auditada con usuario y motivo.
- AC-3.17 — Una venta de una sesión ya `CERRADA` no puede anularse por esta vía.

**Seguridad / roles / auditoría**
- AC-3.18 — `contador` puede leer ventas y cajas pero no ejecuta ninguna mutación de POS.
- AC-3.19 — Descuento sobre umbral por `asistente_de_ventas` exige PIN de supervisor y queda auditado.
- AC-3.20 — Toda operación de POS (abrir/cerrar caja, venta, línea, checkout, anulación, descuento, no-sale) queda registrada en auditoría con usuario, terminal y timestamp.

**Moneda**
- AC-3.21 — Todos los montos persistidos son CLP enteros; no hay decimales en ninguna parte del flujo.

---

## 12. Orden de construcción (sub-bloques)

Mismo patrón que el Bloque 2 (2A→2D):

- **3A — Modelo de datos.** `Terminal`, `SesionCaja`, `Venta`, `LineaVenta`, `DetallePago`, auditoría. Migraciones Prisma. Sin lógica todavía.
- **3B — Carrito ↔ motor de inventario.** Crear venta `BORRADOR`, agregar/quitar líneas mapeadas a `reservar`/`liberar` del Bloque 2, expiración por TTL → `ABANDONADA`. (AC-3.01–3.05, 3.11)
- **3C — Checkout y pagos.** Transacción atómica de confirmación → `VENDIDA`, pagos, pago mixto, folio bajo lock. (AC-3.06–3.10, 3.21)
- **3D — Caja y anulación.** Apertura/cierre con cuadre, no-sale, anulación intra-sesión con reversa (D3-08) y PIN. (AC-3.12–3.20)

No se inicia un sub-bloque hasta que el anterior cumpla sus criterios.

---

## 13. Dependencias y bloqueos previos al código

Antes de escribir código del Bloque 3:
1. Ratificar la **Opción A** del §3 y **agregar la transición de reversa al spec del Bloque 2** (para que ambos specs queden consistentes).
2. Confirmar las decisiones D3-01 a D3-10.
3. Verificar que el motor del Bloque 2 expone la reserva con un `reserva_id` referenciable desde `LineaVenta`.
4. Definir en Settings: umbral de descuento sin PIN y umbral de diferencia de caja sin PIN.
