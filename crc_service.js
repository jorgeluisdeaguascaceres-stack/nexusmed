/*
 * NexusMed · Microservicio de verificación de CRC (Derechos) - Optimizado Coosalud
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
      '--disable-blink-features=AutomationControlled' // Oculta el rastro de bot
    ]
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  let browser;
  try {
    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    
    // 1) Enmascarar el navegador con cabeceras de usuario real
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9' });
    await page.setViewport({ width: 1366, height: 768 });

    // Evita que Coosalud detecte la propiedad navigator.webdriver
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // 2) Navegar al portal de Coosalud
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // 3) Paso a paso del Formulario de Afiliación
    await autoConsultarCoosalud(page, tipoDoc, documento);

    // 4) Capturar y procesar el documento final generado en pantalla
    await page.waitForTimeout(3000); 
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
  // Paso A: Seleccionar Tipo de Documento
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

  // Paso B: Escribir el número de documento
  const inputSel = 'input[type="text"], input[type="number"], input:not([type])';
  await page.waitForSelector(inputSel, { timeout: 5000 });
  await page.focus(inputSel);
  await page.keyboard.type(String(documento), { delay: 50 });

  // Paso C: Clic en el botón "Enviar"
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
      .find(b => (b.textContent || b.value || '').trim().toUpperCase().includes('ENVIAR'));
    if (btn) btn.click();
  });

  // Esperar a que la información cargue en el mismo DOM
  await page.waitForTimeout(4000);

  // Paso D: Buscar y hacer clic en el botón "Certificado"
  const clickedCertificado = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a, button'));
    const btnCert = links.find(l => (l.textContent || '').trim().toUpperCase().includes('CERTIFICADO'));
    if (btnCert) {
      btnCert.click();
      return true;
    }
    return false;
  });

  // Si hizo clic en Certificado, esperar la navegación hacia el visualizador del PDF
  if (clickedCertificado) {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('[crc-service] Activo y enmascarado en puerto ' + PORT);
});
