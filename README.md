# NexusMed · Servicio de verificación de CRC (COOSALUD / FOMAG)

## ¿Por qué hace falta este servicio?
NexusMed corre 100% en el navegador (HTML + localStorage). Por seguridad, el
navegador **no puede** entrar a un portal de otra web (Coosalud, Horus/FOMAG),
llenar el formulario y descargar un PDF de ese sitio. Este microservicio
(Node.js + Puppeteer) sí puede: abre el portal, escribe el tipo y número de
documento, pulsa “Enviar”, espera el resultado y lo devuelve como PDF. NexusMed
lo guarda solo en la casilla **CRC** de esa admisión.

---

## ⚠️ Si tus despliegues en Render aparecen como “Failed”
El error casi siempre es: **Chromium no se instala** en el entorno Node normal
de Render. La solución es desplegar con **Docker** usando la imagen oficial de
Puppeteer (ya incluida en este proyecto con el `Dockerfile`).

### Qué hacer ahora (paso a paso)

1. **Sube estos archivos al repo** (raíz o una subcarpeta): `Dockerfile`,
   `crc_service.js`, `package.json`, `.dockerignore`.

2. En **Render → tu servicio `nexusmed-crc-service` → Settings**:
   - **Runtime / Language:** cambia a **Docker** (si dice “Node”, elimínalo y crea
     el servicio de nuevo eligiendo *“Docker”*; Render detecta el `Dockerfile`).
   - Si pusiste los archivos en una subcarpeta, pon esa ruta en **Root Directory**.
   - **Deja vacíos** los campos *Build Command* y *Start Command* (los define el
     Dockerfile).
   - No necesitas configurar `PORT` a mano; Render lo inyecta y el server ya lo lee.

3. Pulsa **Manual Deploy → Deploy latest commit** y espera a que quede **Live**.

4. Prueba que responde abriendo en el navegador:
   `https://nexusmed-crc-service.onrender.com/`  → debe mostrar
   `{"ok":true,"service":"nexusmed-crc-service"}`.

5. En **NexusMed → Configuración → Gestión de EPS → Automatización de CRC**
   pega: `https://nexusmed-crc-service.onrender.com` y guarda.

6. En **Gestión de EPS**, en cada EPS (Coosalud, FOMAG) pon la **URL de
   verificación** de su portal (ej. Coosalud: `https://coosalud.com/estado-de-afiliacion/`).

7. Listo: en **Gestión Documental**, al abrir un lote de un paciente de Coosalud
   o FOMAG, el botón morado **“Verificar CRC”** consulta el portal y guarda el
   PDF automáticamente en la casilla CRC.

> **Nota del plan gratuito:** el servicio se “duerme” por inactividad, así que la
> primera consulta después de un rato puede tardar ~50 s en despertar. Es normal.

---

## Cómo funciona el llenado automático
El servicio usa un autocompletado **genérico** que sirve para la mayoría de
portales públicos:
1. Elige el tipo de documento en el primer `<select>` del formulario.
2. Escribe el número en el primer campo de texto visible.
3. Pulsa el botón cuyo texto sea Enviar / Buscar / Consultar / Verificar.
4. Espera el resultado y lo guarda como PDF.

Esto funciona para el portal público de Coosalud (estado de afiliación) y para
Horus/FOMAG sin tocar código. Si algún portal usa una estructura muy distinta y
no rellena bien, hay que ajustar los selectores dentro de `autoConsultar()` en
`crc_service.js`.

---

## Probar en tu computador
```bash
npm install
node crc_service.js
# queda escuchando en http://localhost:10000
```
Para ver el navegador mientras trabaja:
```bash
HEADLESS=false node crc_service.js
```

## Endpoint
`POST /crc`
```json
{ "eps": "COOSALUD", "url": "https://coosalud.com/estado-de-afiliacion/", "tipoDoc": "CC", "documento": "123", "numAdmision": "A-001" }
```
Respuesta:
```json
{ "ok": true, "pdfBase64": "JVBERi0xLjQ..." }
```
