# Bloque 2 — Catálogo y autoridad de inventario

> El hub del sistema. La pieza de la que cuelga todo y la que nunca se cerró antes.
> Resuelve las dos sangrías: la sobreventa (verdad del stock) y la ceguera de margen (costo y precio por producto).
> TERMINADO = cumple todos los criterios de aceptación (§6). Las decisiones abiertas están en §8.

---

## 1. Objetivo

Establecer dos cosas:
1. **El catálogo** de productos, con costo y precio, de modo que el sistema sepa cuánto deja cada producto (margen = precio − costo).
2. **La autoridad de inventario:** la verdad de cada unidad/cantidad de stock, que solo cambia vía el contrato `reservar → (confirmar | liberar)` bajo candado de fila. Este bloque construye el **motor**; los canales (POS, web, ferias) lo consumen después.

---

## 2. Alcance de este bloque (qué SÍ se construye)

1. **Catálogo con categorías:** singles TCG, sellado, accesorios, snacks. Cada producto pertenece a una categoría y (si aplica) a un juego.
2. **Dos modos de rastreo de stock:**
   - **Por unidad** (singles): cada carta es una fila con estado `DISPONIBLE` / `RESERVADA` / `VENDIDA`.
   - **Por cantidad** (sellado / snacks / accesorios): un producto con contadores `disponible` y `reservada`.
3. **Contrato de inventario** `reservar → (confirmar | liberar)` bajo candado de fila (`SELECT ... FOR UPDATE`), como **única vía** para mover stock. (Ver fundación §3.) En este bloque se construye y se prueba el motor; aún sin venta real.
4. **Costo y precio por producto**, con **margen = precio − costo** siempre calculado.
5. **Modelo de precio** (ver §5).
6. **Modelo de costo** (ver §5).
7. **Importación masiva de singles de Magic** vía CSV de ManaBox (ver §7).
8. **Ubicación de stock** como atributo (default: `tienda`). Modelado para soportar ferias a futuro, pero este bloque opera solo sobre la tienda.
9. **Movimientos de stock auditables:** entrada por carga, salida por confirmación de venta, ajuste, y (modelado) transferencia entre ubicaciones. Cada movimiento registra tipo, usuario, fecha y cantidad.

---

## 3. Modelo de datos — catálogo

**Producto (común):** id, categoría, juego (nullable), nombre, costo, precio, modo de rastreo (`UNIDAD` | `CANTIDAD`), ubicación, activo.

**Single (atributos extra, derivados del CSV de ManaBox):** set (código + nombre), número de coleccionista, foil, rareza, condición, idioma, Scryfall ID, misprint, altered. La identidad vendible de un single = Scryfall ID + foil + condición + idioma.

**Juego:** nombre, y **fuente de precio de referencia** (CardKingdom para MTG; TCGPlayer para One Piece, Pokémon, Riftbound, Flesh and Blood).

---

## 4. Inventario — máquina de estados

- **Por unidad:** `DISPONIBLE → RESERVADA → VENDIDA`, con `RESERVADA → DISPONIBLE` al liberar.
- **Por cantidad:** reservar mueve N de `disponible` a `reservada`; confirmar descuenta de `reservada` (queda vendido); liberar devuelve de `reservada` a `disponible`.
- Ambos casos, **siempre bajo candado de fila.** El stock disponible nunca se edita a mano libremente: los ajustes son movimientos registrados.

---

## 5. Modelo de precio y costo

### 5.1 Precio de venta
- **Singles:** precio de referencia (según el juego) × **multiplicador de venta** (configurable, default **1.000 CLP**), con **ajuste manual por demanda** (especialmente One Piece y Riftbound). El resultado se **redondea** según regla configurable (ceil_500, ceil_1000, round_500, round_100 — heredado de onplay-manager).
- **Sellado:** precio manual, mirando tiendas de referencia (Magic Forever, Magic Sur, Piedra Bruja).
- **Accesorios / snacks:** precio manual.

### 5.2 Costo — capacidad NUEVA que agrega el ERP
> Importante: hoy el costo **no se registra en ningún lado**. onplay-manager solo maneja precio de venta. La columna `Purchase price` del CSV es la base del precio de **venta**, no el costo. Capturar costo (y por lo tanto margen) es nuevo, y **no sale del CSV de ManaBox**. El costo se conoce en la *compra*, no en el escaneo de venta.

Orígenes del costo:
1. **Bulk a granel / sellado abierto:** se ingresa el **costo total negociado** del lote o de la caja, y el sistema lo **distribuye entre las cartas ponderado por su precio de venta** (una carta que vale el 10% del valor del lote carga el 10% del costo). (D2: CERRADO — costo por carta.)
2. **Trade (cliente vende sus cartas):** costo = referencia × **multiplicador de compra** (configurable, default **400 CLP**). Costo limpio y por unidad.

> Margen = precio de venta (CLP) − costo (CLP). Nota de moneda: precio de referencia y trade vienen en USD; el ERP necesita un manejo configurable de USD→CLP para el margen.

### 5.3 Reglas
- Los multiplicadores (venta 1.000, compra 400) son **configurables sin tocar código** — el dólar se mueve.
- La fuente de referencia depende del juego, no es única.
- Competencia directa (Crows, FileCity, DeckKingdom, Oops, Fenix Store — misma galería, Merced 832) se anota como contexto de negocio; no entra al modelo de precio automático.

---

## 6. Importación ManaBox (contrato concreto)

**Origen:** la app local genera el CSV escaneando con ManaBox. **El ERP recibe el CSV directamente** y se vuelve el importador; la app local de carga se retira. (Coherente con "el ERP es el padre".)

**Columnas del CSV:** `Name, Set code, Set name, Collector number, Foil, Rarity, Quantity, ManaBox ID, Scryfall ID, Purchase price, Misprint, Altered, Condition, Language, Purchase price currency`.

**Mapeo al catálogo:**
| CSV | Catálogo |
|-----|----------|
| Scryfall ID + Foil + Condition + Language | Identidad vendible del single |
| Name, Set code, Set name, Collector number, Rarity, Misprint, Altered | Atributos del single |
| Quantity | Cantidad a ingresar |
| Purchase price (USD) | Base del **precio de venta** = valor × multiplicador de venta → CLP, redondeado |
| Language, Condition, Foil | Idioma, condición, foil |

> El **costo no viene** en el CSV. La importación trae el precio de venta; el costo se ingresa aparte en la compra (ver §5.2).

**Lógica de transformación heredada de onplay-manager (probada, se reusa como conocimiento):**
- SKU: `{SET_CODE}-{collector_number}-{CONDICIÓN}-{IDIOMA}` (ej. `EOE-308-NM-EN`).
- Imagen: URL de Scryfall construida desde el Scryfall ID (`cards.scryfall.io/normal/front/{c1}/{c2}/{id}.jpg`).
- Mapeo de condición (`near_mint`→NM, `lightly_played`→LP, …) e idioma (`en`→Inglés, `es`→Español, …).
- Sufijo `(Foil)` al nombre cuando `Foil = foil`, para no duplicar nombres.

**Reglas de importación:**
- **Idempotente:** reimportar el mismo lote no duplica stock.
- **Solo Magic** se carga por CSV de ManaBox. **One Piece, Pokémon, Riftbound y Flesh and Blood se cargan a mano.** (D3: CERRADO — dos caminos de carga.)

> La jerarquía de categorías y los atributos globales (Estado/Idioma para filtros HUSKY) son lógica de **publicación a WooCommerce** → pertenecen al **bloque 5**, no a este bloque. El bloque 2 importa al catálogo del ERP, no publica en onplay.cl.

---

## 7. Criterios de aceptación (definición de TERMINADO)

- [ ] Se puede crear un producto de cada tipo (single, sellado, accesorio, snack) con costo y precio.
- [ ] El sistema calcula y muestra el **margen = precio − costo** por producto.
- [ ] Para un single, el **precio sugerido = referencia × multiplicador de venta**, y es ajustable a mano.
- [ ] **Reservar** una unidad/cantidad la pasa a `RESERVADA` bajo candado; un segundo intento sobre la última unidad disponible es **rechazado**.
- [ ] **Confirmar** pasa a `VENDIDA`; **liberar** vuelve a `DISPONIBLE`.
- [ ] **Importar el CSV de ManaBox** crea/actualiza los singles de Magic con sus atributos, cantidad y **precio de venta** (con SKU, imagen Scryfall y sufijo Foil heredados de onplay-manager).
- [ ] **Reimportar** el mismo CSV no duplica stock (idempotente).
- [ ] **Cargar un bulk:** se ingresa el costo total y el sistema distribuye el costo por carta ponderado por su valor de referencia.
- [ ] Todo movimiento de stock queda **registrado** (tipo, usuario, fecha, cantidad).
- [ ] Los **multiplicadores** de venta y compra son configurables sin tocar código.

---

## 8. Fuera de alcance de este bloque (explícito)

- Cualquier **publicación o sincronización hacia WooCommerce / onplaygames.cl** → bloque 5. (Regla de oro: el spoke no se toca antes que el hub.) **onplay-manager sigue siendo el puente** que publica los singles de Magic en onplay.cl hasta que el bloque 5 lo reemplace; este bloque no lo toca.
- **Flujo de ferias** (transferencia + reconciliación) → posterior. Este bloque modela "ubicación" pero opera sobre la tienda.
- **Feed automático de precios** desde CardKingdom / TCGPlayer (integración frágil) → posterior. La referencia se ingresa manual o viene en el CSV.
- **La venta en sí** (carrito, pago, voucher, caja) → bloque 3. Este bloque solo entrega el motor de reserva.

---

## 9. Decisiones

- **D1 — ¿Qué número lleva la columna `Purchase price` del CSV?** CERRADO. Es la **base del precio de venta** (USD → ×multiplicador → CLP, redondeado), tal como lo usa onplay-manager hoy. El **costo nunca se ha registrado**; capturarlo es una capacidad nueva del ERP, que entra en la compra (no en el CSV). Ver §5.2.
- **D2 — Costo de singles de bulk / sellado abierto:** CERRADO. Costo **por carta**, distribuyendo el total del lote ponderado por valor de referencia. (Las cartas vía ManaBox ya traen costo por carta.)
- **D3 — Juegos que no son Magic:** CERRADO. Carga **manual** para One Piece, Pokémon, Riftbound y Flesh and Blood. El bloque 2 tiene dos caminos de carga: CSV de ManaBox (Magic) + manual (resto).
