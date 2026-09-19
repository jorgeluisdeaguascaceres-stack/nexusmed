/*
 * NexusMed · Microservicio de verificación de CRC (Derechos) - Enrutador Coosalud + FOMAG
 * -----------------------------------------------------------------------------------
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

    // =========================================================================
    // ENRUTADOR INTELIGENTE POR URL
    // =========================================================================
    if (url.includes('coosalud.com')) {
      // 1. Ejecutar Flujo Quirúrgico de Coosalud
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await autoConsultarCoosalud(page, tipoDoc, documento);
      
      // Limpieza visual Coosalud
      await page.evaluate(() => {
        const elementos = Array.from(document.querySelectorAll('*'));
        elementos.forEach(el => {
          if ((el.textContent || '').includes('Cannot read properties') && el.children.length === 0) {
            if (el.parentElement) el.parentElement.style.display = 'none';
          }
        });
        const enlaces = Array.from(document.querySelectorAll('a, button'));
        enlaces.forEach(el => {
          if ((el.textContent || '').toUpperCase().includes('DESCARGAR CERTIFICADO')) el.style.display = 'none';
        });
      });

    } else if (url.includes('horus-health.com') || url.includes('fomag')) {
      // 2. Flujo Híbrido para FOMAG / HORUS debido al reCAPTCHA
      // Si detecta FOMAG, arrojamos un error controlado para que tu frontend 
      // abra la ventana manual directamente en el flujo de consulta manual.
      await browser.close();
      return res.status(400).json({ 
        ok: false, 
        isManualRequired: true,
        error: 'El portal de FOMAG requiere validación de reCAPTCHA humana. Abriendo asistente manual...' 
      });

    } else {
      // 3. Flujo Genérico para otras EPS
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      // Aquí puedes mapear flujos genéricos en el futuro
    }
    
    // Generación del PDF final
    const pdfBuffer = await page.pdf({ 
      format: 'A4', 
      printBackground: true, 
      margin: { top: '5mm', bottom: '5mm', left: '5mm', right: '5mm' } 
    });

    await browser.close();
    return res.json({ ok: true, pdfBase64: Buffer.from(pdfBuffer).toString('base64') });

  } catch (err) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Función de consulta automatizada de Coosalud (Ya probada y perfecta)
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
      RC: ['RC', 'REGISTRO CIVIL']
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

  await page.waitForFunction(() => {
    const elements = Array.from(document.querySelectorAll('a, button, .btn'));
    return elements.some(el => (el.textContent || '').toUpperCase().includes('CERTIFICADO'));
  }, { timeout: 15000 }).catch(() => {});

  const urlCertificado = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('a, button, .btn'));
    const btnCert = elements.find(el => (el.textContent || '').toUpperCase().includes('CERTIFICADO'));
    if (btnCert) {
      if (btnCert.tagName === 'A' && btnCert.href) return btnCert.href;
      return btnCert.getAttribute('href') || btnCert.getAttribute('onclick') || null;
    }
    return null;
  });

  if (urlCertificado && (urlCertificado.startsWith('http') || urlCertificado.includes('GetCertificate'))) {
    let targetUrl = urlCertificado;
    if (!targetUrl.startsWith('http')) {
      targetUrl = new URL(urlCertificado, page.url()).href;
    }
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));
  } else {
    await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('a, button, .btn'));
      const btnCert = elements.find(el => (el.textContent || '').toUpperCase().includes('CERTIFICADO'));
      if (btnCert) btnCert.click();
    });
    await new Promise(r => setTimeout(r, 6000));
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('[crc-service] Enrutador inteligente corriendo en puerto ' + PORT);
});
