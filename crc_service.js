/*
 * NexusMed · Microservicio de verificación de CRC (Derechos)
 * ---------------------------------------------------------
 * El frontend de NexusMed (HTML + localStorage) NO puede automatizar
 * portales externos ni descargar PDFs de otros dominios por seguridad
 * del navegador (CORS + sandbox). Este servicio Node.js resuelve eso:
 * abre el portal de la EPS con Puppeteer, escribe tipo y número de
 * documento, pulsa "Buscar", descarga el PDF del CRC y lo devuelve en
 * base64 para que NexusMed lo guarde en la casilla CRC.
 *
 * ATENCIÓN: los selectores CSS de cada portal son PLACEHOLDERS. Debes
 * abrir el portal real de COOSALUD y de Horus Health (FOMAG), inspeccionar
 * los campos (F12 → Inspeccionar) y reemplazar los selectores marcados
 * con  // TODO  por los reales.
 *
 * Uso local:
 *   npm install
 *   node crc_service.js
 *   -> escucha en http://127.0.0.1:8080
 *
 * Endpoint:
 *   POST /crc
 *   body JSON: { eps, url, tipoDoc, documento, numAdmision }
 *   respuesta: { ok:true, pdfBase64:"..." }  ó  { ok:false, error:"..." }
 */

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());                       // permite llamadas desde NexusMed
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 10000;
const HEADLESS = process.env.HEADLESS !== 'false';   // HEADLESS=false para ver el navegador

/* ---- Salud ---- */
app.get('/', (_req, res) => res.json({ ok: true, service: 'nexusmed-crc-service' }));

/* ---- Verificación de CRC ---- */
app.post('/crc', async (req, res) => {
  const { eps = '', url = '', tipoDoc = 'CC', documento = '' } = req.body || {};
  if (!url)       return res.status(400).json({ ok: false, error: 'Falta la URL del portal de la EPS' });
  if (!documento) return res.status(400).json({ ok: false, error: 'Falta el número de documento' });

  const epsUp = String(eps).toUpperCase();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: HEADLESS ? 'new' : false,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    let pdfBuffer;
    if (epsUp.includes('COOSALUD')) {
      pdfBuffer = await consultarCoosalud(page, tipoDoc, documento);
    } else if (epsUp.includes('FOMAG') || epsUp.includes('HORUS')) {
      pdfBuffer = await consultarHorusFomag(page, tipoDoc, documento);
    } else {
      throw new Error('EPS no soportada para automatización: ' + eps);
    }

    await browser.close();
    return res.json({ ok: true, pdfBase64: pdfBuffer.toString('base64') });
  } catch (err) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* =====================================================================
 * COOSALUD  — ajusta los selectores // TODO al portal real
 * ===================================================================== */
async function consultarCoosalud(page, tipoDoc, documento) {
  // TODO: selector del <select> de tipo de documento
  //   await page.select('#tipoDocumento', mapTipoDocCoosalud(tipoDoc));
  // TODO: selector del input de número de documento
  //   await page.type('#numeroDocumento', String(documento));
  // TODO: selector del botón Buscar
  //   await Promise.all([
  //     page.click('#btnBuscar'),
  //     page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
  //   ]);

  // El resultado se guarda como PDF. Dos estrategias típicas:
  //  A) La página de resultado se imprime a PDF directamente:
  return await page.pdf({ format: 'A4', printBackground: true });

  //  B) Hay un botón "Descargar PDF" que emite un archivo. En ese caso
  //     hay que interceptar la descarga (ver descargarPDF() abajo) y
  //     devolver ese buffer en lugar de page.pdf().
}

/* =====================================================================
 * FOMAG (Horus Health)  — ajusta los selectores // TODO al portal real
 * ===================================================================== */
async function consultarHorusFomag(page, tipoDoc, documento) {
  // TODO: selector del <select> de tipo de documento en Horus
  //   await page.select('select[name="tipoId"]', mapTipoDocHorus(tipoDoc));
  // TODO: selector del input de documento
  //   await page.type('input[name="numeroId"]', String(documento));
  // TODO: botón consultar
  //   await Promise.all([
  //     page.click('button[type="submit"]'),
  //     page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
  //   ]);

  return await page.pdf({ format: 'A4', printBackground: true });
}

/* ---------------------------------------------------------------------
 * Helpers para mapear el tipo de documento de NexusMed al valor que use
 * cada portal. Ajústalos según los <option value="..."> reales.
 * ------------------------------------------------------------------- */
function mapTipoDocCoosalud(t) {
  const m = { CC: 'CC', TI: 'TI', CE: 'CE', PA: 'PA', RC: 'RC', MS: 'MS', AS: 'AS' };
  return m[String(t).toUpperCase()] || 'CC';
}
function mapTipoDocHorus(t) {
  const m = { CC: '1', TI: '2', CE: '3', PA: '4', RC: '5' };  // TODO: valores reales
  return m[String(t).toUpperCase()] || '1';
}

/* ---------------------------------------------------------------------
 * (Opcional) Interceptar una descarga real de PDF en vez de imprimir la
 * página. Úsalo si el portal entrega un archivo al pulsar "Descargar".
 * ------------------------------------------------------------------- */
// const fs = require('fs');
// const os = require('os');
// const path = require('path');
// async function descargarPDF(page, clickSelector) {
//   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-'));
//   const client = await page.target().createCDPSession();
//   await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
//   await page.click(clickSelector);
//   // esperar a que aparezca el archivo
//   let file;
//   for (let i = 0; i < 60 && !file; i++) {
//     await new Promise(r => setTimeout(r, 500));
//     file = fs.readdirSync(dir).find(f => f.endsWith('.pdf'));
//   }
//   if (!file) throw new Error('No se descargó el PDF');
//   return fs.readFileSync(path.join(dir, file));
// }

// En Render (y otros PaaS) hay que escuchar en 0.0.0.0 y usar process.env.PORT.
const serverPort = process.env.PORT || 10000;
app.listen(serverPort, '0.0.0.0', () => {
  console.log('[crc-service] escuchando de forma publica en el puerto ' + serverPort);
});


