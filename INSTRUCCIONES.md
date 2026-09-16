# NexusMed Patch v2.7 — Instrucciones de Deploy

## Archivos incluidos

| Archivo | Cambio principal |
|---|---|
| `configuracion.html` | Rediseño completo: layout sidebar + paneles individuales (7 secciones) con lazy-init |
| `facturacion.html` | Fallback defensivo `obtenerNumAdmision(p)` para numAdmision vacío |
| `nexus_db.js` | Sin cambios (persistencia NXDB v2.6) |
| `rips.html` | Sin cambios |
| `permisos.js` | Sin cambios |

## Cambios detallados

### configuracion.html — Sidebar + Paneles

- **Antes**: Las 7 secciones (Usuarios, IPS, CUPS, EPS, Matriz, Prueba, Mantenimiento) estaban apiladas verticalmente en una sola página con scroll infinito.
- **Ahora**: Sidebar izquierdo con íconos + panel derecho individual. Solo se muestra un panel a la vez; clic en sidebar cambia el panel activo.
- **CSS**: Nuevo `.config-layout` (flex), `.config-sidebar` (230px), `.config-content` (flex:1), `.config-panel` (display:none except `.active`).
- **Responsive**: En pantallas <900px el sidebar se convierte en fila horizontal de íconos.
- **JS**: `PANEL_INIT` object + `switchPanel(pid)` / `initPanel(pid)` con lazy-init (solo inicializa la primera vez que se visita cada panel).
- **Modales** (`modalEditar`, `modalFicha`) quedan fuera del layout y no se ven afectados.
- **Panel EPS** incluye también "Estado del Sistema" (como antes).

### facturacion.html — Fallback numAdmision

- Se agregó función helper `obtenerNumAdmision(p)` que:
  1. Retorna `p.numAdmision` si existe y no está vacío.
  2. Si no, busca en `nexus_pacientes` por documento y obtiene el último numAdmision.
  3. Si lo encuentra, actualiza `p.numAdmision` en el objeto para llamadas futuras.
- Reemplazó 3 ocurrencias críticas: `llenarDatosPaciente`, `recalcularLiquidacion`, `construirFactura` / `llenarResumenEmitir`.
- Las 2 ocurrencias en la lista de búsqueda de admisiones NO se cambiaron (no necesitan fallback).

## Pasos de deploy

### Opción A: Repositorio GitHub

```bash
# 1. Clonar o actualizar repo
gh repo clone jorgeluisdeaguascaceres-stack/nexusmed
# (o cd al directorio existente)

# 2. Copiar archivos del patch
cp configuracion.html  nexusmed/configuracion.html
cp facturacion.html     nexusmed/facturacion.html
cp nexus_db.js          nexusmed/nexus_db.js
cp rips.html            nexusmed/rips.html
cp permisos.js          nexusmed/permisos.js

# 3. Commit y push
cd nexusmed
git add .
git commit -m "v2.7: sidebar config + fallback numAdmision"
git push

# 4. Render detecta el push y redespliega automáticamente
```

### Opción B: Deploy manual en Render Dashboard

1. Ir a https://dashboard.render.com → seleccionar servicio `nexusmed-plto`
2. Si usa conexión GitHub, el push anterior basta.
3. Si usa deploy manual, subir los archivos vía drag-and-drop o conectar branch actualizada.

## Verificación post-deploy

1. Acceder a `https://nexusmed-plto.onrender.com/configuracion.html`
2. Verificar sidebar izquierdo con 7 ítems.
3. Clic en cada ítem → solo ese panel debe mostrarse.
4. Probar lazy-init: abrir DevTools → Console → cambiar de panel → verificar que funciones init solo se ejecutan la primera vez.
5. Ir a `facturacion.html` → seleccionar un paciente con admisión → verificar que numAdmision se muestra correctamente.
6. Probar con un paciente SIN numAdmision explícito → debe buscar en nexus_pacientes.

## Rollback

Si algo falla, restaurar versión anterior desde Git:
```bash
git revert HEAD
git push
```

O restaurar backup local: `configuracion.html.bak` (1520 líneas originales).
