# NexusMed · Servicio de verificación de CRC (COOSALUD / FOMAG)

## ¿Por qué hace falta este servicio?
NexusMed corre 100% en el navegador. Por seguridad, el navegador **no puede**
entrar a un portal de otra web (Coosalud, Horus/FOMAG), llenar el formulario y
descargar un PDF. Este microservicio (Node.js + Puppeteer) sí puede: abre el
portal, escribe el tipo y número de documento, pulsa “Enviar”, espera el
resultado y lo devuelve como PDF. NexusMed lo guarda en la casilla **CRC**.

---

## ❌ “El botón me sigue mandando a la página y no hace el proceso”
Esto pasa por UNA de estas dos razones. Revísalas EN ORDEN:

### Causa 1 (la más común): NO configuraste la URL del servidor en NexusMed
El botón morado aparece siempre para Coosalud/FOMAG, pero para que descargue
solo el PDF necesita saber la dirección de TU servicio de Render.

1. Copia la URL de tu servicio en Render (arriba en la página del servicio,
   algo como `https://nexusmed-crc-service.onrender.com`).
2. En NexusMed ve a **Configuración → Gestión de EPS → Automatización de CRC**.
3. Pega ahí esa URL y pulsa **Guardar servidor**.
4. Comprueba que la URL responde: ábrela en el navegador y debe mostrar
   `{"ok":true,"service":"nexusmed-crc-service"}`.

> Con la versión nueva de `gestion_documental.html`, si esta URL está vacía el
> botón YA NO te manda al portal: te avisa en rojo que falta configurarla.

### Causa 2: el servicio está “Live” pero Puppeteer no encuentra Chrome
Tu servicio en Render está como **Node** y quedó “Live”, pero eso solo significa
que el servidor arrancó; al intentar abrir el navegador (Chrome) falla porque no
se instaló. Arréglalo así **sin cambiar de servicio**:

En **Render → tu servicio → Settings**:
1. **Build Command:**
   ```
   npm install && npx puppeteer browsers install chrome
   ```
2. **Start Command:**
   ```
   node crc_service.js
   ```
3. En **Environment → Add Environment Variable**, agrega:
   - **Key:** `PUPPETEER_CACHE_DIR`
   - **Value:** `/opt/render/project/src/.cache/puppeteer`
4. Guarda y pulsa **Manual Deploy → Clear build cache & deploy**.

Esto descarga Chrome dentro del proyecto (donde sí persiste) y Puppeteer lo
encuentra al ejecutarse. Sube también el `package.json` nuevo (trae un
`postinstall` que instala Chrome automáticamente).

> **Alternativa más robusta (Docker):** si aun así falla, usa el `Dockerfile`
> incluido (imagen oficial de Puppeteer con Chrome ya integrado). Para eso hay
> que crear el servicio eligiendo **Docker** en vez de Node.

---

## Prueba rápida de que TODO quedó bien
1. `https://TU-SERVICIO.onrender.com/` → muestra `{"ok":true,...}`.
2. En NexusMed, URL del servidor pegada en Automatización de CRC.
3. En cada EPS, su URL de verificación (Coosalud: `https://coosalud.com/estado-de-afiliacion/`).
4. En Gestión Documental, abre un lote de un paciente Coosalud/FOMAG y pulsa
   **Verificar CRC**. El botón muestra “Consultando CRC…” y luego aparece el PDF
   guardado en la casilla CRC.

> Plan gratis de Render: el servicio se “duerme” por inactividad; la primera
> consulta puede tardar ~50 s en despertar. Es normal.

---

## Llenado automático
El servicio usa un autocompletado genérico: elige el tipo de documento en el
primer `<select>`, escribe el número en el primer campo de texto y pulsa el
botón Enviar/Buscar/Consultar. Funciona con el portal público de Coosalud y con
Horus/FOMAG. Si un portal es muy distinto, se ajusta `autoConsultar()` en
`crc_service.js`.

## Probar en tu computador
```bash
npm install
node crc_service.js   # http://localhost:10000
HEADLESS=false node crc_service.js   # para ver el navegador
```

## Endpoint
`POST /crc` → body `{ eps, url, tipoDoc, documento, numAdmision }` → resp `{ ok:true, pdfBase64:"..." }`.
