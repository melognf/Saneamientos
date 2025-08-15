# Saneamientos — Tablero CIP en tiempo real (Firebase)

## Archivos
- `index.html` — UI con login Email/Password y tablero de estados.
- `estilos.css` — estilos.
- `app.js` — lógica, roles y Firestore en tiempo real.
- `firebase-config.js` — pegá aquí tu configuración web de Firebase.
- `firestore.rules` — copia y publicá en Firestore → Rules.

## Setup rápido
1. **Auth**: Habilitá Email/Password. En *Authentication → Settings → Authorized domains* agrega `localhost`, `127.0.0.1` y tu `USUARIO.github.io`.2. **Usuarios**: En **Authentication → Users** crea 3 usuarios y en **Firestore** crea `users/{uid}` con `role: "operacion" | "elaboracion" | "materias"`.3. **Tablero**: En **Firestore** crea `tableros/llenadora` con `current: "sin_solicitud"` y `updatedAt: server timestamp`.4. **Reglas**: pegá `firestore.rules` y publicá.5. **GitHub Pages**: subí estos archivos a la **raíz del repo** (o `docs/` si tu Pages usa esa carpeta).

## Notas
- Si preferís usar colección `usuarios` en lugar de `users`, cambia esas rutas en `app.js` y en `firestore.rules`.
- Para depurar, abrí DevTools → Console y verificá que `app.js` cargue sin errores y que `firebase-config.js` tenga tu `apiKey` real (empieza con `AIza...`).

¡Éxitos!
