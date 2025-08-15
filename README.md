# CIP demo — Firebase tiempo real con PIN por sector (Anonymous Auth)

## Idea
Para demo sin correos: cada persona elige su **sector** y escribe un **PIN**. El cliente inicia sesión con **Anonymous Auth** y crea `users/{uid}` con su `role`. Las **reglas** validan el PIN contra la colección `demo` para permitir la creación. Luego todo el tablero funciona en **tiempo real** como antes.

## Pasos
1. **Auth** → **Sign-in method** → habilitar **Anonymous**.2. **Firestore**:   - Colección `demo` con 3 docs y campo `pin`:     - `demo/operacion` → `{ pin: "1111" }`\ 
     - `demo/elaboracion` → `{ pin: "2222" }`\ 
     - `demo/materias` → `{ pin: "3333" }`   - Colección `tableros` → doc `llenadora` → `current: "sin_solicitud"`, `updatedAt: serverTimestamp`.   - **Rules**: pegar `firestore.rules` y **Publicar**.
3. **Config web**: en `firebase-config.js` pegá tu configuración real (Project settings → General → Web app).
4. **GitHub Pages / Hosting**: subí estos archivos a tu sitio. Listo para mostrar **tiempo real**.

## Notas
- Los PINs están en `demo/*`. Cámbialos cuando quieras.- El doc `users/{uid}` se crea **solo una vez**. Si el usuario cierra sesión, la próxima sesión anónima genera **otro UID** (útil para demos).- Podés migrar a Email/Password más adelante sin cambiar el tablero.

¡Éxitos con la demo!
