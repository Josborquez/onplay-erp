# CLAUDE.md — Reglas de comportamiento para construir el ERP Onplay

> Este archivo le dice a Claude Code *cómo* comportarse al escribir código.
> El documento `00-fundacion.md` le dice *qué* construir. Los dos se leen juntos.
> Base: principios de Andrej Karpathy sobre los errores típicos de los LLM al programar.

---

## Parte A — Principios generales (proceso)

### 1. Pensar antes de codear
**No asumir. No esconder la confusión. Mostrar los tradeoffs.**
- Declarar los supuestos de forma explícita. Si hay incertidumbre, **preguntar en vez de adivinar.**
- Cuando hay ambigüedad, presentar las interpretaciones posibles — no elegir una en silencio.
- Hacer push-back cuando existe un camino más simple: decirlo.
- Frenar cuando algo no está claro: nombrar qué es lo confuso y pedir aclaración.

### 2. Simplicidad primero
**El mínimo código que resuelve el problema. Nada especulativo.**
- Cero funcionalidades más allá de lo pedido.
- Cero abstracciones para código de un solo uso.
- Cero "flexibilidad" o "configurabilidad" que no se pidió.
- Cero manejo de errores para escenarios imposibles.
- Si 200 líneas pueden ser 50, reescribir.
- **Prueba:** ¿un ingeniero senior diría que esto está sobre-complicado? Si sí, simplificar.

### 3. Cambios quirúrgicos
**Tocar solo lo necesario. Limpiar solo el propio desorden.**
- No "mejorar" código, comentarios ni formato adyacente.
- No refactorizar lo que no está roto.
- Respetar el estilo existente, aunque uno lo haría distinto.
- Si se detecta código muerto no relacionado, **mencionarlo — no borrarlo.**
- Sí quitar imports/variables/funciones que *los propios cambios* dejaron sin uso.
- **Prueba:** cada línea cambiada debe trazarse directamente a lo pedido.

### 4. Ejecución guiada por objetivos
**Definir criterios de éxito. Iterar hasta verificarlos.**
- Convertir órdenes imperativas en objetivos verificables:
  - "Agregar validación" → "Escribir tests de entradas inválidas y hacerlos pasar".
  - "Arreglar el bug" → "Escribir un test que lo reproduzca y hacerlo pasar".
- Para tareas de varios pasos, declarar un plan breve: `paso → verificación`.
- Criterios de éxito fuertes permiten iterar sin supervisión constante. "Que funcione" es un criterio débil.

**Tradeoff:** estas reglas priorizan **cautela sobre velocidad**. Para cambios triviales (un typo, un one-liner obvio), usar criterio — no toda tarea necesita el rigor completo.

---

## Parte B — Reglas específicas de este proyecto

> Estas reglas no son negociables. Anclan los principios de arriba a la disciplina que ya costó cuatro intentos aprender.

### B1. Construcción bloque a bloque
- Se construye **un bloque a la vez**, en el orden del roadmap de `00-fundacion.md` (§4).
- **Ningún bloque se da por terminado hasta cumplir TODOS sus criterios de aceptación** (la sección "Criterios de aceptación" de cada spec). Ni antes, ni con extras.
- No empezar el bloque siguiente con el actual a medias.

### B2. No reiniciar desde cero
- El patrón que hundió los intentos anteriores fue: cuando algo no funcionaba, se abandonaba y se empezaba un sistema nuevo. **Está prohibido.** Si algo no funciona, se arregla.
- Se reutiliza el conocimiento del prototipo OnplayPOSv2: su **modelo de datos** y sus **dos auditorías**. Se descarta su código.

### B3. El ERP es el padre — la regla de oro
- **WooCommerce no se toca hasta que el ERP sea dueño de la verdad de cada unidad de stock** (bloque 5, no antes).
- Ningún canal (web, POS, feria) descuenta stock por su cuenta. Todo movimiento pasa por el contrato `reservar → (confirmar | liberar)` bajo candado de fila (`SELECT ... FOR UPDATE`). Ver `00-fundacion.md` §3.

### B4. Los pagos son el último borde
- Hasta el bloque 6, se trabaja con un "pago confirmado" **simulado**. El núcleo (inventario, wallet) debe quedar completo y verificado antes de enchufar Webpay / Mercado Pago.

### B5. Stack fijo
- Node.js + Express + Prisma + MySQL (ERP) · React + Vite + Tailwind (frontend). No introducir frameworks ni dependencias nuevas sin justificarlo y preguntarlo primero (ver Principio 1 y 2).

### B6. Seguridad: no repetir errores de la auditoría
- Credenciales (PIN, claves) siempre hasheadas, nunca en texto plano.
- Comparaciones de credenciales timing-safe.
- Débitos de saldo y reservas de stock siempre bajo candado de fila. Sin fallback silencioso.

---

## Cómo saber que está funcionando

- Diffs con solo los cambios pedidos — sin refactors "de paso".
- Código simple a la primera, sin reescrituras por sobre-complicación.
- Las preguntas de aclaración llegan **antes** de implementar, no después del error.
- Cada bloque cierra contra sus criterios de aceptación, no contra una sensación de "ya está".
