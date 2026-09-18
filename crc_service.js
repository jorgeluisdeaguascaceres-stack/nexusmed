/*
 * NexusMed · Microservicio de verificación de CRC (Derechos)
 * ---------------------------------------------------------
 * El frontend de NexusMed (HTML + localStorage) NO puede automatizar
 * portales externos ni descargar PDFs de otros dominios por seguridad
 * del navegador. Este servicio Node.js lo hace: abre el portal de la EPS
 * con Puppeteer, escribe tipo y número de documento, pulsa "Enviar/Buscar",
 * espera el resultado y lo devuelve como PDF en base64.
 *
 * Endpoint:  POST /crc
 *   body: { eps, url, tipoDoc, documento, numAdmision }
 *   resp: { ok:true, pdfBase64:"..." }  ó  { ok:false, error:"..." }
 */

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 10000;
const HEADLESS = process.env.HEADLESS !== 'false';

/* ---- Salud ---- */
app.get('/', (_req, res) => res.json({ ok: true, service: 'nexusmed-crc-service' }));

/* ---- Verificación de CRC ---- */
app.post('/crc', async (req, res) => {
  const { eps = '', url = '', tipoDoc = 'CC', documento = '' } = req.body || {};
  if (!url)       return res.status(400).json({ ok: false, error: 'Falta la URL del portal de la EPS' });
  if (!documento) return res.status(400).json({ ok: false, error: 'Falta el número de documento' });

  const launchOpts = {
    headless: HEADLESS ? 'new' : false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  };
  // La imagen oficial de Puppeteer (Docker) expone la ruta de Chrome aquí.
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  let browser;
  try {
    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Autocompletado genérico: sirve para Coosalud, Horus/FOMAG y similares.
    await autoConsultar(page, tipoDoc, documento);

    // Espera prudente a que cargue el resultado y lo convierte a PDF.
    await sleep(3500);
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' } });

    await browser.close();
    return res.json({ ok: true, pdfBase64: Buffer.from(pdfBuffer).toString('base64') });
  } catch (err) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* =====================================================================
 * Autocompletado genérico del formulario de consulta.
 *  1) Selecciona el tipo de documento en el primer <select> que encuentre.
 *  2) Escribe el número en el primer input de texto/número visible.
 *  3) Pulsa el botón de envío (Enviar / Buscar / Consultar).
 * Funciona en la mayoría de portales públicos (Coosalud estado-de-afiliacion,
 * Horus/FOMAG, etc.). Si un portal usa nombres muy distintos, ver las notas.
 * ===================================================================== */
async function autoConsultar(page, tipoDoc, documento) {
  // 1) Tipo de documento en el primer <select> disponible.
  await page.evaluate((tipo) => {
    const sel = document.querySelector('select');
    if (!sel) return;
    const t = String(tipo).toUpperCase();
    // Mapa de sinónimos por si el <option> trae el texto completo.
    const alias = {
      CC: ['CC', 'CEDULA', 'CÉDULA', 'CIUDADANIA', 'CIUDADANÍA'],
      TI: ['TI', 'TARJETA'],
      CE: ['CE', 'EXTRANJERIA', 'EXTRANJERÍA'],
      RC: ['RC', 'REGISTRO CIVIL'],
      PA: ['PA', 'PASAPORTE'],
      MS: ['MS'], AS: ['AS'], PT: ['PT', 'PERMISO', 'PPT']
    };
    const wanted = alias[t] || [t];
    let elegido = null;
    for (const opt of Array.from(sel.options)) {
      const v = (opt.value || '').toUpperCase();
      const txt = (opt.textContent || '').toUpperCase();
      if (wanted.some(w => v === w || v.includes(w) || txt.includes(w))) { elegido = opt; break; }
    }
    if (elegido) {
      sel.value = elegido.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, tipoDoc);

  // 2) Número de documento en el primer input de texto/número visible.
  const inputSel = 'input[type="text"], input[type="number"], input[type="tel"], input[type="search"], input:not([type])';
  await page.evaluate((sel, doc) => {
    const inputs = Array.from(document.querySelectorAll(sel))
      .filter(i => i.offsetParent !== null && !i.disabled && i.type !== 'hidden');
    const inp = inputs[0];
    if (inp) {
      inp.focus();
      inp.value = String(doc);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, inputSel, documento);

  // 3) Botón de envío: por texto (Enviar/Buscar/Consultar) o por tipo submit.
  const clicked = await page.evaluate(() => {
    const textos = ['ENVIAR', 'BUSCAR', 'CONSULTAR', 'VERIFICAR'];
    const cands = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, a[role="button"]'));
    let btn = cands.find(b => {
      const t = (b.textContent || b.value || '').trim().toUpperCase();
      return textos.some(x => t.includes(x));
    });
    if (!btn) btn = document.querySelector('input[type="submit"], button[type="submit"]');
    if (btn) { btn.click(); return true; }
    // Último recurso: enviar el formulario directamente.
    const f = document.querySelector('form');
    if (f) { f.submit(); return true; }
    return false;
  });

  // Si el clic disparó navegación, la esperamos (sin fallar si no ocurre).
  if (clicked) {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// En Render (y otros PaaS) hay que escuchar en 0.0.0.0 y usar process.env.PORT.
app.listen(PORT, '0.0.0.0', () => {
  console.log('[crc-service] escuchando en el puerto ' + PORT);
});
