# Fundación del proyecto — ERP Onplay (erp.onplaygames.cl)

> Este documento es la fuente de verdad de las decisiones del proyecto.
> Si una decisión no está aquí, no está tomada. Si cambia, se edita aquí primero.
> Objetivo de este documento: que el conocimiento NO se reinicie entre intentos.

**Empresa:** BM Limitada — nombre de fantasía Onplay Games.
**Rubro:** Tienda de TCG, juegos de mesa, coleccionables y organización de eventos. Santiago de Chile.
**Ecosistema actual:** Hostinger · WordPress + WooCommerce 10.8.1 (onplay.cl, onplaygames.cl) · pagos Transbank Webpay y Mercado Pago.

---

## 1. El problema raíz que este proyecto resuelve

No existe una única fuente de verdad. Ni del stock (se vende en tienda física una unidad que la web sigue mostrando disponible → sobreventa) ni del crédito de clientes (papel + Excel → descontrol del saldo). Todo lo demás son síntomas de eso.

**Patrón de fracaso a evitar:** los intentos anteriores no fracasaron por mala tecnología — fracasaron porque, cuando algo no terminaba de funcionar, se abandonaba y se empezaba un sistema nuevo. La disciplina de este proyecto es: **bloque a bloque, cada bloque funcionando de verdad y verificado antes de pasar al siguiente.**

---

## 2. Decisiones arquitectónicas cerradas

| # | Decisión | Estado |
|---|----------|--------|
| A1 | **ERP autoritativo (el padre).** Un ERP central es la única fuente de verdad. Los canales (web, POS, ferias) son hijos que piden permiso, no deciden por su cuenta. | CERRADA |
| A2 | **Proyecto nuevo y limpio.** Se descarta el código del prototipo OnplayPOSv2. Se conserva su modelo de datos y sus dos auditorías como conocimiento. | CERRADA |
| A3 | **Stack:** Node.js + Express + Prisma + MySQL (backend/ERP) · React + Vite + Tailwind (frontend). | CERRADA |
| A4 | **Modelo de venta:** reserva con candado. Ningún canal descuenta stock por su cuenta. | CERRADA |

---

## 3. Invariante central — Autoridad de inventario

Esta es la pieza vital de la que cuelga todo. Es lo que nunca se cerró antes.

- Cada **unidad** de stock vive en exactamente uno de tres estados: `DISPONIBLE` · `RESERVADA` · `VENDIDA`.
- Nadie cambia ese estado sin pasar por el ERP, y el ERP lo hace **bajo candado de fila (`SELECT ... FOR UPDATE`)**. Esto previene la race condition que las auditorías marcaron como crítica.
- Contrato único de movimiento: **reservar → (confirmar | liberar)**.
  - El canal pide `reservar(unidad)`. El ERP, bajo candado, confirma a uno y rechaza a los demás.
  - Si el pago se concreta → `confirmar` → la unidad pasa a `VENDIDA`.
  - Si el pago falla o expira → `liberar` → la unidad vuelve a `DISPONIBLE`.
- **Ferias offline = ubicación, no excepción.** Antes de salir se transfiere stock a la ubicación "feria"; esas unidades dejan de ser vendibles por web/tienda. Al volver se reconcilia. El ERP nunca pierde la verdad.

**Matiz por tipo de producto** (define cuánto rigor necesita cada categoría):

- **Singles (cantidad = 1):** gate autoritativo obligatorio. El conflicto no es raro, es garantizado cuando ocurre, porque hay una sola copia física.
- **Sellado / snacks / accesorios (cantidad > 1):** tienen colchón; toleran reconciliación asíncrona sin riesgo grave.

---

## 4. Actores y roles del sistema

Hay dos poblaciones distintas, y no se mezclan en el mismo sistema de login.

### 4.1 Staff interno (operadores del ERP) — 4 roles
| Rol | Acceso |
|-----|--------|
| **Super admin sistema** | Todo, incluida la configuración técnica del sistema (staff técnico / desarrollo). |
| **Administrador tienda** | Operación completa: ventas, inventario, wallet, eventos, usuarios. Sin lo técnico de sistema. |
| **Contador** | Módulo contable y reportes financieros. Solo lo suyo. |
| **Asistente de ventas** | POS, ventas, tickets de evento y reportes básicos. |

### 4.2 Cliente wallet — NO es staff
Es un cliente que entra a ver **su propio** saldo de crédito. Población distinta, autenticación distinta. **Su acceso se define en el bloque 4 (Wallet)**, no en el login de staff del bloque 1.

---

## 5. Roadmap de bloques

Orden deliberado: primero el hub (la verdad), después los spokes (los canales), los pagos al final por ser el borde más volátil.

| Bloque | Nombre | Por qué va en este orden |
|--------|--------|--------------------------|
| **1** | Login (Google o correo/clave) + bloqueo por inactividad con PIN + roles de staff | Infraestructura de identidad. Todo lo demás necesita saber quién opera. |
| **2** | Catálogo + autoridad de inventario | El hub. Producto, costo, precio, y la máquina de estados del stock. |
| **3** | POS / venta en mostrador | Primer canal que reserva→confirma. Incluye: caja (apertura/cierre + monto), turnos (mañana 11–15, tarde 15–21), formas de pago (efectivo, débito, crédito, crédito tienda, mixto), voucher impreso, carrito que se conserva y reactiva, y registro del vendedor para métricas. |
| **4** | Wallet / crédito de tienda | Libro mayor del crédito. Definición cerrada en §6. Incluye el acceso del cliente wallet. |
| **5** | Integración WooCommerce | Publicar y sincronizar onplaygames.cl. **Aquí el ERP reemplaza a onplay-manager** (el importador CSV→WooCommerce actual, que es el puente temporal). **Territorio de mayor riesgo** (el plumbing anterior nunca funcionó de verdad). |
| **6** | Pagos reales (Webpay / Mercado Pago) | Borde intercambiable. Hasta aquí se trabaja con "pago confirmado" simulado. |

**Regla de oro:** WooCommerce no se toca hasta que el ERP sea dueño de la verdad de cada unidad. Levantar el spoke antes que el hub es el error de origen.

---

## 6. Decisión cerrada — Wallet (bloque 4), definición preservada

Se documenta ahora aunque se construya en el bloque 4, para no perder la definición.

**Qué es:** un **libro mayor inmutable** de crédito de tienda. El crédito entra principalmente como **premio de torneo**. Lo que está roto hoy no es el descuento — es que no hay fuente de verdad del saldo (papel + Excel → el cliente no sabe cuánto tiene; a veces la tienda tampoco).

**Reglas duras del wallet:**

1. **Libro inmutable.** Cada movimiento (abono, compra, ajuste, expiración) se registra y no se edita. El saldo es la suma de los lotes vivos, **nunca un número tecleado a mano.**
2. **Lotes con expiración propia.** Cada abono es un lote que guarda su propia fecha de expiración. La regla de negocio es única —**todo el crédito muere el 31 de diciembre del año en curso, por motivo contable**— pero la fecha concreta se calcula y se guarda *en cada lote* al momento de cargar (un abono de feb-2026 guarda 31/12/2026; uno de ene-2027 guarda 31/12/2027).
3. **Consumo FIFO** por fecha de expiración (se gasta primero lo que vence antes). En la práctica solo importa en el cambio de año, cuando convive saldo viejo con saldo nuevo.
4. **Proceso de expiración.** Al pasar el 31/12, un proceso marca los lotes vencidos como muertos para que dejen de contar en el saldo, y **registra el monto expirado por cliente** (asiento contable: ingreso para la tienda). Sin este proceso, el 1 de enero el saldo queda mal y nadie sabe por qué.
5. **Saldo disponible** = suma de lotes vivos no vencidos.
6. **Notificación por correo en cada movimiento** (cliente, tipo, monto, saldo resultante, fecha de expiración). El diseño existente del correo es bueno y se reutiliza.
7. **Seguridad del débito:** candado de fila en el descuento (la falta de esto fue una causa crítica en la auditoría anterior). Sin fallback silencioso.

**Fuera de alcance del wallet:** el cálculo del reparto de premios de torneo (top 4, 80/20, etc.) **no** va aquí — va en el bloque de Eventos. Cuando exista, el premio simplemente llamará al libro para abonar.

---

## 7. Pendientes de decisión

- ~~Nombre/dominio definitivo~~ → **CERRADO.** El ERP vive en `https://erp.onplaygames.cl/` (subdominio propio, sin costo ni trámite adicional). Uso interno del staff de Onplay.
- Las preguntas abiertas de cada bloque viven en su propio spec.
