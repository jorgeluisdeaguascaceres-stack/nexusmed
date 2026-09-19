/*
 * NexusMed · Microservicio de verificación de CRC (Derechos) - Enrutador Coosalud + FOMAG
 * -----------------------------------------------------------------------------------
 * FOMAG / Horus Health (horus2.horus-health.com):
 *   - El login está protegido por reCAPTCHA "No soy un robot". NO se automatiza el login.
 *   - TÚ inicias sesión a mano UNA vez en tu navegador (resuelves el reCAPTCHA como humano)
 *     y copias tus COOKIES de sesión. Este servicio las inyecta en un navegador headless y
 *     automatiza SOLO lo de después: Verificación -> tipo doc + número -> BUSCAR ->
 *     CERTIFICADO DE AFILIACIÓN -> descarga el PDF -> pdfBase64.
 */

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 10000;
const HEADLESS = process.env.HEADLESS !== 'false';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.get('/', (_req, res) => res.json({ ok: true, service: 'nexusmed-crc-service', status: 'ready' }));

// Carpeta de PERFIL PERSISTENTE de FOMAG: aquí se guarda tu sesión de Horus.
// Inicias sesión UNA vez (resolviendo el reCAPTCHA a mano) y la sesión queda
// guardada en disco; las consultas siguientes son automáticas hasta que caduque.
const FOMAG_PROFILE_DIR = process.env.FOMAG_PROFILE_DIR || path.join(__dirname, '.fomag-profile');

function fomagLaunchOpts(headless) {
  const o = {
    headless: headless ? 'new' : false,
    userDataDir: FOMAG_PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) o.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  return o;
}

// Navegador FOMAG SIEMPRE VIVO: se abre UNA vez y NO se cierra, para que el login
// manual y TODAS las consultas usen exactamente el mismo navegador y la misma sesión.
let fomagBrowser = null;
let fomagPage = null;
async function getFomagBrowser() {
  if (fomagBrowser && fomagBrowser.isConnected()) return fomagBrowser;
  fomagBrowser = await puppeteer.launch(fomagLaunchOpts(HEADLESS));
  fomagBrowser.on('disconnected', () => { fomagBrowser = null; fomagPage = null; });
  return fomagBrowser;
}
async function getFomagPage() {
  const browser = await getFomagBrowser();
  if (fomagPage && !fomagPage.isClosed()) return fomagPage;
  const pages = await browser.pages();
  fomagPage = pages[0] || await browser.newPage();
  try {
    await fomagPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await fomagPage.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9' });
    await fomagPage.setViewport({ width: 1366, height: 768 });
  } catch (_) {}
  return fomagPage;
}

// Detecta si la página actual es el login (pide contraseña / reCAPTCHA).
function esPaginaLoginJS() {
  const t = document.body ? document.body.innerText.toUpperCase() : '';
  return !!document.querySelector('input[type="password"]') ||
         t.includes('NO SOY UN ROBOT') || t.includes('RECUPERAR CONTRASEÑA');
}

// -----------------------------------------------------------------------------
// LOGIN MANUAL (una sola vez). Abre el navegador VISIBLE para que inicies sesión
// y resuelvas el reCAPTCHA tú mismo; la sesión se guarda en el perfil persistente.
// IMPORTANTE: este endpoint necesita ejecutarse en un equipo CON pantalla
// (tu computador), no en un servidor headless como Render.
// -----------------------------------------------------------------------------
app.post('/fomag/login', async (req, res) => {
  const { url = 'https://horus2.horus-health.com' } = req.body || {};
  try {
    const page = await getFomagPage();          // MISMO navegador que usarán las consultas
    await page.bringToFront().catch(() => {});
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    // Espera hasta 5 min a que TÚ inicies sesión en ESTA ventana (menú Aseguramiento visible).
    const loggedIn = await page.waitForFunction(() => {
      const t = document.body ? document.body.innerText.toUpperCase() : '';
      const hayPass = !!document.querySelector('input[type="password"]');
      return !hayPass && (t.includes('ASEGURAMIENTO') || t.includes('VERIFICACI') ||
                          t.includes('TRANSCRIPCIONES') || t.includes('CENTRO REGULADOR'));
    }, { timeout: 300000 }).then(() => true).catch(() => false);
    // NO cerramos el navegador: queda vivo para que las consultas usen esta sesión.
    if (!loggedIn) return res.status(408).json({ ok: false, error: 'No se detectó inicio de sesión (tiempo agotado). Vuelve a intentar.' });
    return res.json({ ok: true, message: 'Sesión de FOMAG activa. El navegador queda abierto; las consultas ya son automáticas.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Convierte fomagCookies (string "a=b; c=d" o array [{name,value}]) a formato Puppeteer.
function parseCookies(raw, url) {
  const domain = new URL(url).hostname;
  const out = [];
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (c && c.name) out.push({ name: c.name, value: String(c.value == null ? '' : c.value), domain: c.domain || domain, path: c.path || '/' });
    }
  } else if (typeof raw === 'string') {
    raw.split(';').forEach(pair => {
      const i = pair.indexOf('=');
      if (i > 0) {
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        if (name) out.push({ name, value, domain, path: '/' });
      }
    });
  }
  return out;
}

// =============================================================================
// FOMAG / HORUS · Reutiliza tu sesión (cookies) y automatiza la verificación.
// =============================================================================
async function handleFomagPuppeteer(browser, { url, verificacionUrl, tipoDoc, documento, fomagCookies }) {
  const origin = new URL(url).origin;
  const page = await getFomagPage();   // MISMA pestaña/sesión del login

  // Carpeta temporal para descargas del certificado.
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fomag-'));
  try {
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  } catch (_) {}

  // Captura de PDF por respuesta de red (listener temporal, se retira al terminar).
  let pdfBuffer = null;
  const onResponse = async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const cd = (resp.headers()['content-disposition'] || '').toLowerCase();
      if (!pdfBuffer && (ct.includes('application/pdf') || cd.includes('.pdf'))) {
        pdfBuffer = await resp.buffer();
      }
    } catch (_) {}
  };
  page.on('response', onResponse);

  try {
    // Refuerzo OPCIONAL: inyectar cookies si vienen en el body.
    const cookies = parseCookies(fomagCookies, url);
    if (cookies.length) { try { await page.setCookie(...cookies); } catch (_) {} }

    // Ir directo a Verificación (ya autenticado => sin login ni reCAPTCHA).
    const target = verificacionUrl || (origin + '/#/aseguramiento/verificacion');
    await page.goto(target, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3000);

    if (await page.evaluate(esPaginaLoginJS)) {
      const e = new Error('No hay sesión activa de FOMAG. Inicia sesión una vez con /fomag/login (en la ventana que se abre) y reintenta.');
      e.isTokenExpired = true;
      throw e;
    }

    return await finalizarFomag(browser, page, downloadDir, { tipoDoc, documento, getPdf: () => pdfBuffer, setPdf: (b) => { pdfBuffer = b; } });
  } finally {
    try { page.removeListener('response', onResponse); } catch (_) {}
    try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// Pasos 4-8: tipo doc -> número -> BUSCAR -> CERTIFICADO -> capturar PDF.
async function finalizarFomag(browser, page, downloadDir, { tipoDoc, documento, getPdf, setPdf }) {
  await sleep(600);

  // 4) Seleccionar TIPO DE DOCUMENTO (soporta <select> nativo).
  const okTipo = await page.evaluate((tipo) => {
    const t = String(tipo).toUpperCase();
    const alias = {
      CC: ['CEDULA', 'CÉDULA', 'CIUDADANIA', 'CC'],
      TI: ['TARJETA', 'TI'],
      CE: ['EXTRANJERIA', 'CE'],
      RC: ['REGISTRO CIVIL', 'RC'],
      PA: ['PASAPORTE', 'PA']
    };
    const wanted = alias[t] || [t];
    for (const sel of Array.from(document.querySelectorAll('select'))) {
      const opt = Array.from(sel.options).find(o => {
        const s = ((o.textContent || '') + ' ' + (o.value || '')).toUpperCase();
        return wanted.some(w => s.includes(w));
      });
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
    }
    return false;
  }, tipoDoc);

  // 4b) Fallback: dropdown tipo Angular Material / ng-select / custom.
  if (!okTipo) {
    try {
      const trigger = await page.$('mat-select, [role="combobox"], .mat-select, .ng-select, .dropdown-toggle');
      if (trigger) { await trigger.click(); await sleep(900); }
      await page.evaluate((tipo) => {
        const t = String(tipo).toUpperCase();
        const alias = { CC:['CEDULA','CÉDULA','CIUDADANIA'], TI:['TARJETA'], CE:['EXTRANJERIA'], RC:['REGISTRO CIVIL'], PA:['PASAPORTE'] };
        const wanted = alias[t] || [t];
        const opts = Array.from(document.querySelectorAll('mat-option, [role="option"], .dropdown-item, li, option'));
        const opt = opts.find(o => wanted.some(w => (o.textContent || '').toUpperCase().includes(w)));
        if (opt) opt.click();
      }, tipoDoc);
      await sleep(500);
    } catch (_) {}
  }

  // 5) Escribir NÚMERO DE DOCUMENTO en el input más probable.
  await page.evaluate((doc) => {
    const inputs = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent !== null);
    const score = (el) => {
      const meta = ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('formcontrolname') || '') + ' ' + (el.getAttribute('name') || '') + ' ' + (el.id || '')).toUpperCase();
      let s = 0;
      if (meta.includes('DOCUMENTO') || meta.includes('NUMERO') || meta.includes('NÚMERO')) s += 5;
      if (el.type === 'number') s += 2;
      if (el.type === 'text' || !el.type) s += 1;
      if (['password', 'hidden', 'checkbox', 'radio'].includes(el.type)) s -= 20;
      return s;
    };
    const target = inputs.sort((a, b) => score(b) - score(a))[0];
    if (target) {
      target.focus();
      target.value = '';
      target.value = String(doc);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, documento);
  await sleep(500);

  // 6) Click en BUSCAR.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, input[type="submit"], a, .btn'))
      .find(x => (x.textContent || x.value || '').trim().toUpperCase().includes('BUSCAR'));
    if (b) b.click();
  });

  // 7) Esperar el botón CERTIFICADO DE AFILIACIÓN.
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('button, a, .btn'))
      .some(el => (el.textContent || '').toUpperCase().includes('CERTIFICADO'));
  }, { timeout: 20000 }).catch(() => {});

  // 8) Click en CERTIFICADO DE AFILIACIÓN y capturar el PDF.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a, .btn'))
      .find(el => (el.textContent || '').toUpperCase().includes('CERTIFICADO'));
    if (b) b.click();
  });

  // Esperar el PDF: por red o por archivo descargado (hasta ~25s).
  for (let i = 0; i < 50 && !getPdf(); i++) {
    try {
      const f = fs.readdirSync(downloadDir).find(n => /\.pdf$/i.test(n));
      if (f) {
        const full = path.join(downloadDir, f);
        const s1 = fs.statSync(full).size;
        await sleep(400);
        if (fs.existsSync(full) && s1 > 0 && fs.statSync(full).size === s1) { setPdf(fs.readFileSync(full)); break; }
      }
    } catch (_) {}
    await sleep(500);
  }

  // Fallback: popup con el PDF a la vista -> renderizarlo.
  if (!getPdf()) {
    try {
      const pages = await browser.pages();
      const extra = pages.find(p => p !== page && /pdf|certificad|getcertificate/i.test(p.url()));
      if (extra) { await extra.bringToFront().catch(() => {}); setPdf(await extra.pdf({ format: 'A4', printBackground: true })); }
    } catch (_) {}
  }

  try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch (_) {}

  if (!getPdf()) {
    throw new Error('Se ejecutó la consulta pero no se capturó el PDF. Verifica que la sesión siga activa y que exista el botón CERTIFICADO DE AFILIACIÓN.');
  }
  return { ok: true, pdfBase64: Buffer.from(getPdf()).toString('base64') };
}

app.post('/crc', async (req, res) => {
  const { url = '', tipoDoc = 'CC', documento = '', fomagCookies = null, verificacionUrl = '' } = req.body || {};
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
  if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

  // --- FOMAG / HORUS: navegador siempre vivo (mismo del login), sin cerrarlo ---
  if (url.includes('horus-health.com') || url.toLowerCase().includes('fomag')) {
    try {
      const browser = await getFomagBrowser();
      const out = await handleFomagPuppeteer(browser, { url, verificacionUrl, tipoDoc, documento, fomagCookies });
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
        Array.from(document.querySelectorAll('*')).forEach(el => {
          if ((el.textContent || '').includes('Cannot read properties') && el.children.length === 0) {
            if (el.parentElement) el.parentElement.style.display = 'none';
          }
        });
        Array.from(document.querySelectorAll('a, button')).forEach(el => {
          if ((el.textContent || '').toUpperCase().includes('DESCARGAR CERTIFICADO')) el.style.display = 'none';
        });
      });
    } else {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    }

    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '5mm', bottom: '5mm', left: '5mm', right: '5mm' } });
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
