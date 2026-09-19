/*
 * NexusMed · Microservicio de verificación de CRC (Derechos) - Versión Final Coosalud
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

    // 1. Ir a la página del formulario
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // 2. Rellenar y enviar formulario
    await autoConsultarCoosalud(page, tipoDoc, documento);

    // 3. ESPERA A QUE APAREZCA EL BOTÓN CERTIFICADO
    await page.waitForFunction(() => {
      const elements = Array.from(document.querySelectorAll('a, button, .btn'));
      return elements.some(el => (el.textContent || '').toUpperCase().includes('CERTIFICADO'));
    }, { timeout: 15000 }).catch(() => {});

    // 4. EXTRAER LA URL DIRECTA DEL CERTIFICADO (MÉTODO ULTRA-SEGURO)
    const urlCertificado = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('a, button, .btn'));
      const btnCert = elements.find(el => (el.textContent || '').toUpperCase().includes('CERTIFICADO'));
      if (btnCert) {
        // Si es un enlace <a>, extraemos el href directo
        if (btnCert.tagName === 'A' && btnCert.href) return btnCert.href;
        // Si usa un comportamiento onclick o similar, intentamos capturar el atributo correspondiente o fallback
        return btnCert.getAttribute('href') || btnCert.getAttribute('onclick') || null;
      }
      return null;
    });

    // 5. NAVEGAR DIRECTAMENTE AL PDF E IMPRIMIR
    if (urlCertificado && (urlCertificado.startsWith('http') || urlCertificado.includes('GetCertificate'))) {
      let targetUrl = urlCertificado;
      // Si la URL es relativa, la unimos con el dominio base
      if (!targetUrl.startsWith('http')) {
        targetUrl = new URL(urlCertificado, page.url()).href;
      }
      
      // Forzamos al navegador a ir directo al recurso del PDF
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 4000));
    } else {
      // Fallback: Si no pudimos leer la URL, hacemos clic tradicional y esperamos
      await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('a, button, .btn'));
        const btnCert = elements.find(el => (el.textContent || '').toUpperCase().includes('CERTIFICADO'));
        if (btnCert) btnCert.click();
      });
      await new Promise(r => setTimeout(r, 6000));
    }
    
    // 6. Generar el PDF final limpio
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

  const inputSel = 'input[type="text"], input[type="number"], input:not([type])';
  await page.waitForSelector(inputSel, { timeout: 5000 });
  await page.focus(inputSel);
  await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, inputSel);
  await page.keyboard.type(String(documento), { delay: 50 });

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"], .btn'));
    const btnEnviar = btns.find(b => (b.textContent || b.value || '').trim().toUpperCase().includes('ENVIAR'));
    if (btnEnviar) btnEnviar.click();
  });

  await new Promise(r => setTimeout(r, 4000));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('[crc-service] Activo y enmascarado en puerto ' + PORT);
});
