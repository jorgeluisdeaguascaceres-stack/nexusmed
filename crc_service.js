/*
 * NexusMed · Microservicio de verificación de CRC (Derechos) - Optimizado Coosalud v2
 * -----------------------------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 10000;
const HEADLESS = process.env.HEADLESS !== 'false';

app.get('/', (_req, res) => res.json({ ok: true, service: 'nexusmed-crc-service', status: 'ready' }));

app.post('/crc', async (req, res) => {
  const { url = '', tipoDoc = 'CC', documento = '' } = req.body || {};
  if (!url)       return res.status(400).json({ ok: false, error: 'Falta la URL del portal de la EPS' });
  if (!documento) return res.status(400).json({ ok: false, error: 'Falta el número de documento' });

  const launchOpts = {
    headless: HEADLESS ? 'new' : false,
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox', 
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-blink-features=AutomationControlled'
    ]
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  let browser;
  try {
    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9' });
    await page.setViewport({ width: 1366, height: 768 });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    await autoConsultarCoosalud(page, tipoDoc, documento);

    // Reemplazo de waitForTimeout por función nativa segura
    await new Promise(r => setTimeout(r, 4000)); 
    
    const pdfBuffer = await page.pdf({ 
      format: 'A4', 
      printBackground: true, 
      margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' } 
    });

    await browser.close();
    return res.json({ ok: true, pdfBase64: Buffer.from(pdfBuffer).toString('base64') });
  } catch (err) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

async function autoConsultarCoosalud(page, tipoDoc, documento) {
  // 1. Esperar y seleccionar el Tipo de Documento
  await page.waitForSelector('select', { timeout: 10000 });
  await page.evaluate((tipo) => {
    const sel = document.querySelector('select');
    if (!sel) return;
    const t = String(tipo).toUpperCase();
    const alias = {
      CC: ['CC', 'CEDULA', 'CÉDULA'],
      TI: ['TI', 'TARJETA'],
      CE: ['CE', 'EXTRANJERIA'],
      RC: ['RC', 'REGISTRO CIVIL'],
      PA: ['PA', 'PASAPORTE']
    };
    const wanted = alias[t] || [t];
    const elegido = Array.from(sel.options).find(opt => {
      const v = (opt.value || '').toUpperCase();
      const txt = (opt.textContent || '').toUpperCase();
      return wanted.some(w => v === w || txt.includes(w));
    });
    if (elegido) {
      sel.value = elegido.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, tipoDoc);

  // 2. Esperar, limpiar e ingresar el número de documento
  const inputSel = 'input[type="text"], input[type="number"], input:not([type])';
  await page.waitForSelector(inputSel, { timeout: 5000 });
  await page.focus(inputSel);
  // Limpiamos el input por si acaso
  await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, inputSel);
  await page.keyboard.type(String(documento), { delay: 60 });

  // 3. Hacer clic en el botón "Enviar" usando coordenadas o evento nativo
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"], .btn'));
    const btnEnviar = btns.find(b => (b.textContent || b.value || '').trim().toUpperCase().includes('ENVIAR'));
    if (btnEnviar) {
      btnEnviar.click();
    }
  });

  // 4. ESPERA CRÍTICA: Esperamos a que la tabla de resultados y el botón "Certificado" aparezcan en pantalla
  // Usamos una evaluación constante en el DOM para buscar el texto 'CERTIFICADO'
  try {
    await page.waitForFunction(() => {
      const elements = Array.from(document.querySelectorAll('a, button, .btn'));
      return elements.some(el => (el.textContent || '').toUpperCase().includes('CERTIFICADO'));
    }, { timeout: 15000 });
  } catch (e) {
    console.log("El botón Certificado no apareció dentro del tiempo límite.");
  }

  // 5. Hacer clic en el botón "Certificado"
  const clickedCertificado = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('a, button, .btn'));
    const btnCert = elements.find(el => (el.textContent || '').toUpperCase().includes('CERTIFICADO'));
    if (btnCert) {
      btnCert.click();
      return true;
    }
    return false;
  });

  // 6. Si el botón abrió el visualizador del certificado en una nueva URL, esperamos a que cargue
  if (clickedCertificado) {
    // Damos un tiempo de espera para que el visor cargue el documento oficial en pantalla
    await new Promise(r => setTimeout(r, 6000));
  }
}
