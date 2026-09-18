# NexusMed · Servicio de verificación de CRC (COOSALUD / FOMAG)

## ¿Por qué hace falta este servicio?
NexusMed es una app **100% de navegador** (HTML + localStorage). Por seguridad,
el navegador **no puede** entrar a un portal de otra página web (COOSALUD, Horus
Health de FOMAG), llenar formularios y descargar un PDF de ese sitio. Eso lo
bloquean las reglas de CORS y el sandbox del navegador.

La solución es este **microservicio aparte** (Node.js + Puppeteer): un pequeño
programa que sí puede abrir el portal como si fuera una persona, escribir el
tipo y número de documento, pulsar “Buscar”, descargar el PDF y devolvérselo a
NexusMed. NexusMed lo guarda solo en la casilla **CRC** de esa admisión.

## Cómo usarlo

### 1) Probar en tu computador
```bash
npm install
node crc_service.js
# queda escuchando en http://localhost:10000 (o el puerto que asigne Render)
```
Para ver el navegador mientras trabaja (útil al ajustar los selectores):
```bash
HEADLESS=false node crc_service.js
```

### 2) Ajustar los selectores de cada portal (IMPORTANTE)
Los campos de cada portal cambian, así que en `crc_service.js` los selectores
vienen como **placeholders** marcados con `// TODO`. Debes:
1. Abrir el portal real (COOSALUD y Horus/FOMAG).
2. Pulsar F12 → Inspeccionar sobre el campo de tipo de documento, el de número
   y el botón Buscar.
3. Copiar sus selectores (id, name o clase) y reemplazar los `// TODO`.
4. Ajustar también `mapTipoDocCoosalud` / `mapTipoDocHorus` con los valores
   reales de cada `<option>`.

Si el portal entrega el PDF con un botón “Descargar”, activa la función
`descargarPDF()` (al final del archivo) en vez de `page.pdf()`.

### 3) Desplegarlo (para usarlo desde cualquier lugar)
Puedes subirlo a Render como **otro** Web Service (aparte de NexusMed):
- Runtime: Node
- Build command: `npm install`
- Start command: `node crc_service.js`
- Necesita Puppeteer con Chromium; en Render usa un plan que permita el buildpack
  de Puppeteer o una imagen Docker con Chromium instalado.

### 4) Conectarlo con NexusMed
En NexusMed abre **Configuración → Gestión de EPS → Automatización de CRC** y
pega la dirección del servicio (por ej. `https://mi-crc-service.onrender.com`).
Guarda. Luego, en **Gestión Documental**, al abrir un lote de un paciente de
COOSALUD o FOMAG aparecerá el botón **“Verificar CRC”** en la casilla CRC.

> Si dejas el servidor en blanco, “Verificar CRC” solo **abre el portal** de la
> EPS en una pestaña nueva para que hagas la consulta a mano y arrastres el PDF.

## Endpoint
`POST /crc`
```json
{ "eps": "COOSALUD", "url": "https://portal...", "tipoDoc": "CC", "documento": "123", "numAdmision": "A-001" }
```
Respuesta:
```json
{ "ok": true, "pdfBase64": "JVBERi0xLjQ..." }
```
