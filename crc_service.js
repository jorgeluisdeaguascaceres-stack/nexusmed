/*
 * NexusMed · Microservicio de verificación de CRC (Derechos) - Enrutador Coosalud + FOMAG
 * -----------------------------------------------------------------------------------
 * FOMAG / Horus Health: NO usa Puppeteer (evita el reCAPTCHA del login). En su lugar
 * reutiliza el token de sesión que TÚ ya obtuviste al iniciar sesión manualmente en el
 * navegador, y llama directo a la API interna de Horus con Authorization: Bearer <token>.
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

// =============================================================================
// FOMAG / HORUS HEALTH  ·  Bypass por Token de Sesión Persistente
// -----------------------------------------------------------------------------
// No abre navegador. Recibe fomagToken (el que copias del navegador con F12) y
// hace peticiones directas a la API interna de Horus inyectando el Bearer token.
// =============================================================================
async function handleFomag({ url, tipoDoc, documento, fomagToken }) {
  if (!fomagToken) {
    const e = new Error('Falta fomagToken. Inicia sesión en Horus y pega tu token de sesión en NexusMed.');
    e.isManualRequired = true;
    throw e;
  }

  // Origen base del portal, p.ej. https://horus-health.com
  const origin = new URL(url).origin;

  // Rutas internas. Ajústalas si en F12 > Network ves otras (ver instrucciones abajo).
  const VERIFY_PATH = process.env.FOMAG_VERIFY_PATH || '/api/aseguramiento/verificacion';
  const CERT_PATH   = process.env.FOMAG_CERT_PATH   || '/AffiliateManager/GetCertificate';

  const authHeaders = {
    'Authorization': `Bearer ${fomagToken}`,
    'Accept': 'application/json, application/pdf, */*',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  // 1) Verificación de aseguramiento -> normalmente devuelve datos del afiliado.
  const verifyRes = await fetch(origin + VERIFY_PATH, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ tipoDocumento: tipoDoc, numeroDocumento: String(documento) })
  });

  if (verifyRes.status === 401 || verifyRes.status === 403) {
    const e = new Error('Token de FOMAG inválido o expirado. Inicia sesión de nuevo y copia un token nuevo.');
    e.isTokenExpired = true;
    throw e;
  }

  let afiliado = null;
  try { afiliado = await verifyRes.json(); } catch (_) { /* algunos endpoints no devuelven JSON */ }

  // 2) Descarga directa del certificado PDF con el MISMO token.
  const certUrl = new URL(origin + CERT_PATH);
  certUrl.searchParams.set('documentType', tipoDoc);
  certUrl.searchParams.set('documentNumber', String(documento));
  const afiliadoId = afiliado && (afiliado.id || afiliado.affiliateId || afiliado.idAfiliado);
  if (afiliadoId) certUrl.searchParams.set('affiliateId', afiliadoId);

  const certRes = await fetch(certUrl.href, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${fomagToken}`, 'Accept': 'application/pdf, */*' }
  });

  if (certRes.status === 401 || certRes.status === 403) {
    const e = new Error('Token de FOMAG inválido o expirado al descargar el certificado.');
    e.isTokenExpired = true;
    throw e;
  }
  if (!certRes.ok) throw new Error(`Horus respondió ${certRes.status} al descargar el certificado.`);

  // 3) Convertir a base64 (soporta PDF binario o JSON con base64).
  const contentType = (certRes.headers.get('content-type') || '').toLowerCase();
  let pdfBase64;
  if (contentType.includes('application/json')) {
    const j = await certRes.json();
    pdfBase64 = j.pdfBase64 || j.base64 || j.file || j.data;
    if (!pdfBase64) throw new Error('La API devolvió JSON pero sin un campo de PDF reconocible.');
    pdfBase64 = String(pdfBase64).replace(/^data:application\/pdf;base64,/, '');
  } else {
    const buf = Buffer.from(await certRes.arrayBuffer());
    pdfBase64 = buf.toString('base64');
  }

  return { ok: true, pdfBase64, afiliado: afiliado || undefined };
}

app.post('/crc', async (req, res) => {
  const { url = '', tipoDoc = 'CC', documento = '', fomagToken = '' } = req.body || {};
  if (!url)       return res.status(400).json({ ok: false, error: 'Falta la URL del portal de la EPS' });
  if (!documento) return res.status(400).json({ ok: false, error: 'Falta el número de documento' });

  // --- FOMAG / HORUS: sin Puppeteer, vía token de sesión ---
  if (url.includes('horus-health.com') || url.toLowerCase().includes('fomag')) {
    try {
      const out = await handleFomag({ url, tipoDoc, documento, fomagToken });
      return res.json(out);
    } catch (err) {
      const status = err.isTokenExpired ? 401 : (err.isManualRequired ? 400 : 500);
      return res.status(status).json({
        ok: false,
        isManualRequired: !!err.isManualRequired,
        isTokenExpired: !!err.isTokenExpired,
        error: err.message
      });
    }
  }

  // --- Resto de EPS (Coosalud / genérico): flujo Puppeteer existente ---
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

    if (url.includes('coosalud.com')) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await autoConsultarCoosalud(page, tipoDoc, documento);

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
    } else {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    }

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
