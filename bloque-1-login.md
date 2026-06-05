# Bloque 1 — Login, sesión y bloqueo de pantalla

> Primer ladrillo. Autocontenido y verificable solo. Todo bloque posterior necesita saber quién opera y con qué rol.
> Un bloque está TERMINADO cuando cumple todos sus criterios de aceptación (§5). Ni antes, ni con extras.
> Estado: definición CERRADA. Sin preguntas abiertas.

---

## 1. Objetivo

Identificar al staff que opera el sistema: permitir entrar, mantener la sesión de forma segura, bloquear la pantalla por inactividad con re-validación rápida por PIN, y establecer el modelo de usuario y roles del que depende todo el control de acceso posterior.

---

## 2. Alcance de este bloque (qué SÍ se construye)

1. **Modelo de usuario** de staff con rol, según los 4 roles de la fundación (§4.1).
2. **Dos métodos de login equivalentes**, ambos solo para usuarios **pre-registrados**:
   - Cuenta de **Google**.
   - **Correo + clave** creada en el sistema (login normal).
   - Cualquiera de los dos lleva a la misma sesión del mismo usuario.
3. **Sesión** emitida por el ERP (JWT), presente y exigida en **todos los endpoints protegidos**.
4. **Registro de auditoría:** quién hace qué y cuándo.
5. **PIN por persona** para re-validar *dentro* de una sesión ya abierta: desbloquear la pantalla y confirmar acciones/menús sensibles. **El PIN no es un método de login.**
6. **Bloqueo por inactividad:** a los N minutos (default 10, configurable), con aviso previo, la **pantalla se bloquea** — la sesión NO se cierra — y se desbloquea con el PIN.
7. **Logout explícito:** cierra la sesión por completo y exige re-login.
8. **Guardas de ruta por rol.**
9. **Seed inicial** de al menos un Super admin sistema (sin él, nadie podría entrar la primera vez).

---

## 3. Requisitos funcionales

### 3.1 Login (dos métodos equivalentes)
- **Google:** el backend valida el token de Google del lado servidor y busca el correo en su tabla de usuarios.
- **Correo + clave:** compara la clave contra el hash almacenado, de forma timing-safe.
- En ambos: solo usuarios pre-registrados y activos. No registrado o inactivo → rechazo con mensaje genérico ("acceso no autorizado"), sin revelar si el correo existe.

### 3.2 Sesión
- La emite el ERP, no Google. Lleva: id de usuario, rol, nombre. Nada sensible.
- La expiración se valida **del lado servidor** (no solo en el navegador).
- El JWT es exigido en todos los endpoints protegidos.

### 3.3 Bloqueo por inactividad
- El contador se reinicia con actividad real (teclado, mouse, touch, navegación).
- A los N minutos: aviso previo → **bloqueo de pantalla**. La sesión sigue viva; la UI queda bloqueada.
- Se **desbloquea con el PIN** del usuario de la sesión.
- N es configurable (default 10 min).

### 3.4 PIN
- **Único por persona.**
- Guardado **hasheado**, comparación **timing-safe**.
- Usos: desbloqueo de pantalla tras inactividad, y re-validación de acciones/menús sensibles.
- **No abre sesión desde cero** (no es login).

### 3.5 Roles y guardas
- Cada usuario tiene exactamente uno de los 4 roles de staff.
- Cada ruta/operación declara los roles permitidos. Rol insuficiente → 403.

### 3.6 Auditoría
- Registrar las acciones relevantes con usuario + timestamp (al menos: login, logout, desbloqueo, acciones sensibles).

---

## 4. Reglas e invariantes

- **R1.** Ningún usuario se crea por iniciar sesión con Google. El alta de usuarios es un acto administrativo (bloque futuro).
- **R2.** La verdad de "quién puede entrar" vive en la tabla de usuarios del ERP, no en Google.
- **R3.** La expiración de sesión y el bloqueo por inactividad se validan en el servidor.
- **R4.** Mensajes de error genéricos: nunca revelar si un correo está o no registrado.
- **R5.** Clave y PIN se guardan hasheados; comparación timing-safe (corrige la vulnerabilidad crítica del prototipo).
- **R6.** El PIN es único por persona.
- **R7.** Todo endpoint protegido exige un JWT válido.

---

## 5. Criterios de aceptación (definición de TERMINADO)

El bloque está listo cuando, demostrablemente:

- [ ] Un usuario pre-registrado puede entrar con su cuenta de Google.
- [ ] Un usuario pre-registrado puede entrar con correo + clave.
- [ ] Un usuario no registrado (Google válido o correo desconocido) **no** puede entrar, y ve un mensaje genérico.
- [ ] Un usuario inactivo (deshabilitado) no puede entrar.
- [ ] Tras N minutos sin actividad, hay un aviso y luego la pantalla se bloquea; la sesión **NO** se cierra.
- [ ] La pantalla bloqueada se desbloquea solo con el PIN correcto del usuario de la sesión.
- [ ] La actividad del usuario reinicia el contador de inactividad.
- [ ] El logout explícito cierra la sesión y exige re-login.
- [ ] Una petición a una ruta protegida con rol insuficiente devuelve 403.
- [ ] Todo endpoint protegido rechaza peticiones sin JWT válido.
- [ ] Clave y PIN se guardan hasheados (verificable en BD: no hay texto plano).
- [ ] Existe al menos un Super admin seed que permite el primer ingreso.
- [ ] Las acciones relevantes quedan en el registro de auditoría con usuario y timestamp.

---

## 6. Fuera de alcance de este bloque (explícito, para no inflar)

- **Caja:** apertura/cierre y confirmación de monto → bloque 3.
- **Turnos** (mañana 11–15, tarde 15–21) y **métricas de quién vendió** → bloque 3. El bloque 1 solo provee la identidad; la venta guarda el vendedor.
- **Formas de pago** (efectivo, débito, crédito, crédito tienda, mixto) y **voucher impreso** → bloque 3.
- **Carrito que se conserva y reactiva** tras un bloqueo → postura registrada (se conserva); el detalle se especifica en el bloque 3.
- **Acceso del "cliente wallet"** → bloque 4 (población distinta: cliente, no staff).
- **CRUD de usuarios** desde la app → bloque de Settings posterior. Por ahora los usuarios se cargan por seed/migración.
- **Recuperación de contraseña.**

---

## 7. Notas de seguridad heredadas de la auditoría

Cosas que el sistema anterior hizo bien y se conservan, y errores que NO se repiten:

- Conservar: JWT con secreto ≥ 32 caracteres validado al arranque; CORS con whitelist; rate limiting en login; Helmet; mensajes de error genéricos.
- No repetir: PIN o clave en texto plano; comparaciones de credenciales no timing-safe; (para bloques posteriores) débitos de saldo y reservas de stock sin candado de fila.
