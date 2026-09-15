# NEXUSMED PATCH v2.6 — Instrucciones de Instalación

## Archivos incluidos

| Archivo | Versión | Cambios |
|---------|---------|----------|
| `nexus_db.js` | v2.6 | Motor de sincronización corregido — previene pérdida de facturas y RIPS |
| `facturacion.html` | v2.5 | Facturación corregida — guarda con número alternativo y pre-facturas |
| `rips.html` | v2.3 | Exportación XML de RIPS + corrección de typo |

## Pasos para actualizar GitHub

### Opción A: Editor Web de GitHub (más fácil)

1. Abra su repositorio: https://github.com/jorgeluisdeaguascaceres-stack/nexusmed
2. Para CADA archivo, haga lo siguiente:
   - Navegue al archivo (ej: `nexus_db.js`)
   - Haga clic en el ícono de lápiz ✏️ (Edit this file)
   - **Seleccione TODO el contenido** (Ctrl+A) y **Borre** (Delete)
   - **Copie TODO el contenido** del archivo nuevo de este patch
   - **Pegue** en el editor de GitHub
   - Haga clic en **Commit changes** (verde)
   - Ponga un mensaje como: `fix: nexus_db.js v2.6 - previene pérdida de facturas`

3. Repita para los 3 archivos:
   - `nexus_db.js` → Mensaje: `fix: motor sincronización v2.6 - previene pérdida de facturas/RIPS`
   - `facturacion.html` → Mensaje: `fix: facturación v2.5 - guarda con número alternativo`
   - `rips.html` → Mensaje: `feat: exportación XML de RIPS`

4. **Render se redespliega automáticamente** al detectar el push (si está conectado al repo)

### Opción B: Subir archivos directamente

1. Vaya a: https://github.com/jorgeluisdeaguascaceres-stack/nexusmed
2. Haga clic en **Add file** → **Upload files**
3. Arrastre los 3 archivos
4. Commit con mensaje: `fix: patch v2.6 - corrige persistencia de facturas y RIPS`

---

## Resumen de Bugs Corregidos

### BUG #1 — CRÍTICO: `bajarTodo()` sobrescribe datos locales
**Problema:** Al navegar a otro módulo, la nueva página carga `nexus_db.js` desde cero. La variable `pendientes={}` queda vacía. `bajarTodo()` lee del servidor (que tiene `[]`) y como no hay pendientes, SOBRESCRIBE localStorage con `[]`, **destruyendo toda factura o RIPS guardado localmente**.

**Fix v2.6:** 
- `pendientes` se persiste en `sessionStorage` (sobrevive navegación entre páginas)
- `bajarTodo()` NUNCA sobrescribe datos locales con datos remotos vacíos
- Si el local tiene datos y el remoto está vacío, marca como pendiente para SUBIR, no para sobrescribir
- Siempre hace MERGE (nunca sobrescribe directamente)

### BUG #2 — Race condition en `enviarPendientes()`
**Problema:** `enviarPendientes()` lee `mio` al inicio, hace fetch/upload asíncrono, luego `almacenarLocal(clave, String(final))` sobrescribe localStorage con un merge obsoleto. Si el usuario guardó datos DURANTE la ventana asíncrona, esos datos se PIERDEN.

**Fix v2.6:**
- Antes de sobrescribir, se re-lee localStorage y se hace un segundo merge
- Post-envío: detecta nuevas claves pendientes y programa reenvío inmediato
- `sendBeacon()` en `beforeunload` como respaldo final

### BUG #3 — Factura silenciosamente descartada con `_editandoId`
**Problema:** Cuando `_editandoId` está seteado pero `idx < 0` (la pre-factura original fue eliminada), tanto `emitirFacturaDefinitiva()` como `guardarPreFactura()` descartan silenciosamente la factura nueva.

**Fix v2.5:**
- Bloque `else` agrega la factura como nueva en vez de descartarla
- Console.warn para diagnóstico

### BUG #4 — `siguienteNumFC()` causa race condition
**Problema:** `siguienteNumFC()` llama `guardar()` que activa NXDB.enviarPendientes() ANTES de que la factura se guarde. Con números alternativos (externos como FE12865), esto es especialmente problemático.

**Fix v2.5:**
- Con número externo: primero guardar la factura, DESPUÉS asignar número interno
- Post-save verification: re-lee localStorage para confirmar que la factura se guardó
- Si falla, reintento automático + aviso al usuario

### NUEVA CARACTERÍSTICA: Exportar RIPS en XML
- Botón "Descargar XML" en la página de RIPS
- Genera archivo XML con estructura válida para entidades pagadoras
- Corrección de typo: `codZonaTerritorialResidencia` (antes tenía error)

---

## Verificación Post-Deploy

Después de que Render redespliegue:

1. Vaya a https://nexusmed-plto.onrender.com
2. Abra DevTools (F12) → Console
3. Debería ver: `[NXDB] Pendientes restaurados de sessionStorage: [...]`
4. Pruebe crear una factura con número alternativo
5. Navegue a otra página y vuelva — la factura debe seguir ahí
6. Verifique que el botón "Descargar XML" aparece en RIPS
