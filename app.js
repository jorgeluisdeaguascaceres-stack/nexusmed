/* Sistema Web de Gestión Documental y Nomenclatura Automatizada
   - Modo servidor: si existe un backend en /api, los lotes y PDFs viven en el servidor central.
   - Modo local: si no hay backend, todo se guarda en la base de datos del navegador (IndexedDB).
   La lógica de nomenclatura, validación y consulta es idéntica en ambos modos. */
(function(){
"use strict";

/* ------------------------------------------------------------------ *
 * Catálogo estricto de documentos
 * ------------------------------------------------------------------ */
var DOCS = [
  { sigla:"CRC", desc:"Firma del paciente documento ADRES" },
  { sigla:"AUT", desc:"Autorizaciones" },
  { sigla:"HEV", desc:"Historia Clínica / Evolución" },
  { sigla:"FEV", desc:"Factura Electrónica de Venta" },
  { sigla:"OPF", desc:"Orden del Profesional / Soporte" },
  { sigla:"EPI", desc:"Historia Clínica Externa" }
];
var SIGLAS = DOCS.map(function(d){ return d.sigla; });

var $ = function(id){ return document.getElementById(id); };
var pending = {};      // sigla -> [File, File, …] aún no procesados (se unen en uno solo)
var activo = null;     // lote activo
var MODE = "local";    // "api" | "local"
var raiz = null;       // carpeta real del equipo elegida por el usuario (opcional)
var HAY_FS = typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
var seleccion = {};    // ids de lotes marcados en la Pantalla B

/* ------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------ */
function limpia(s){
  return String(s == null ? "" : s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim();
}
function limpiaRuta(s){
  // La ruta de destino se respeta tal como la escribe el usuario.
  // Solo se quitan caracteres imposibles y la barra final sobrante.
  var r = String(s == null ? "" : s).replace(/[*?"<>|\u0000-\u001f]/g, "").trim();
  r = r.replace(/\/{2,}/g, "/").replace(/\\{2,}/g, "\\");
  r = r.replace(/[\/\\]+$/, "");
  return r;
}
function unir(ruta, carpeta){
  if(!ruta) return carpeta;
  var sepRuta = ruta.indexOf("\\") >= 0 ? "\\" : "/";
  return ruta + sepRuta + carpeta;
}
function destino(lote){
  return unir(lote.ruta, lote.carpeta);
}
function nombreArchivo(sigla, nit, carpeta, sep){
  return limpia(sigla.toUpperCase() + sep + nit + sep + carpeta) + ".pdf";
}
function human(b){
  if(b < 1024) return b + " B";
  var u = ["KB","MB","GB"], i = -1;
  do { b /= 1024; i++; } while(b >= 1024 && i < 2);
  return b.toFixed(1) + " " + u[i];
}
function fecha(ts){
  var d = new Date(ts), p = function(n){ return (n<10?"0":"")+n; };
  return p(d.getDate())+"/"+p(d.getMonth()+1)+"/"+d.getFullYear()+" "+p(d.getHours())+":"+p(d.getMinutes());
}
function say(el, txt, kind){
  el.textContent = txt || "";
  el.className = "msg" + (kind ? " " + kind : "");
}
function descarga(blob, nombre){
  var a = document.createElement("a"), url = URL.createObjectURL(blob);
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 5000);
}
function esPdf(file){
  return /\.pdf$/i.test(file.name || "") || file.type === "application/pdf";
}
function conNombre(bytes, nombre){
  try { return new File([bytes], nombre, { type:"application/pdf" }); }
  catch(e){
    var b = new Blob([bytes], { type:"application/pdf" });
    try { b.name = nombre; } catch(e2){}
    return b;
  }
}

/* ------------------------------------------------------------------ *
 * Empaquetado ZIP (método store, sin librerías externas)
 * ------------------------------------------------------------------ */
var CRC_T = (function(){
  var t = new Uint32Array(256);
  for(var n=0;n<256;n++){
    var c = n;
    for(var k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1);
    t[n] = c>>>0;
  }
  return t;
})();
function crcUp(c, u8){
  for(var i=0;i<u8.length;i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c>>>8);
  return c>>>0;
}
function W(v, off, val, bytes){
  for(var i=0;i<bytes;i++) v[off+i] = (val >>> (8*i)) & 0xFF;
}
function dosT(d){
  var y = d.getFullYear();
  if(y < 1980) return { t:0, d:0x21 };
  return {
    t: ((d.getHours()<<11) | (d.getMinutes()<<5) | (d.getSeconds()/2|0)) & 0xFFFF,
    d: (((y-1980)<<9) | ((d.getMonth()+1)<<5) | d.getDate()) & 0xFFFF
  };
}
async function crcBlob(blob){
  var c = 0xFFFFFFFF;
  if(blob.stream){
    var rd = blob.stream().getReader();
    for(;;){
      var r = await rd.read();
      if(r.done) break;
      c = crcUp(c, r.value);
    }
  } else {
    c = crcUp(c, new Uint8Array(await blob.arrayBuffer()));
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
async function zipBlobs(items){   // [{path, blob}]
  var enc = new TextEncoder(), parts = [], central = [], offset = 0;
  for(var i=0;i<items.length;i++){
    var it = items[i], nb = enc.encode(it.path);
    var crc = await crcBlob(it.blob), size = it.blob.size, dt = dosT(new Date());
    var lh = new Uint8Array(30 + nb.length);
    W(lh,0,0x04034b50,4); W(lh,4,20,2); W(lh,6,0x0800,2); W(lh,8,0,2);
    W(lh,10,dt.t,2); W(lh,12,dt.d,2); W(lh,14,crc,4);
    W(lh,18,size,4); W(lh,22,size,4); W(lh,26,nb.length,2); W(lh,28,0,2);
    lh.set(nb,30);
    parts.push(lh, it.blob);
    var ch = new Uint8Array(46 + nb.length);
    W(ch,0,0x02014b50,4); W(ch,4,20,2); W(ch,6,20,2); W(ch,8,0x0800,2); W(ch,10,0,2);
    W(ch,12,dt.t,2); W(ch,14,dt.d,2); W(ch,16,crc,4);
    W(ch,20,size,4); W(ch,24,size,4); W(ch,28,nb.length,2);
    W(ch,30,0,2); W(ch,32,0,2); W(ch,34,0,2); W(ch,36,0,2); W(ch,38,0,4); W(ch,42,offset,4);
    ch.set(nb,46);
    central.push(ch);
    offset += lh.length + size;
  }
  var cd = central.reduce(function(a,b){ return a + b.length; }, 0);
  var end = new Uint8Array(22);
  W(end,0,0x06054b50,4); W(end,4,0,2); W(end,6,0,2);
  W(end,8,central.length,2); W(end,10,central.length,2);
  W(end,12,cd,4); W(end,16,offset,4); W(end,20,0,2);
  return new Blob(parts.concat(central,[end]), { type:"application/zip" });
}

/* ------------------------------------------------------------------ *
 * SEGURIDAD: pantalla de acceso, sesión y cambio de contraseña
 *   - Modo servidor: usuarios reales en el servidor central (cookie de sesión).
 *   - Modo local: bloqueo disuasorio guardado en este navegador.
 * ------------------------------------------------------------------ */
var SEG = (function(){
  var modo = "local", usuario = "", rol = "";
  var resolver = null, promesa = null, mostrandoAlta = false, instalar = false;
  var LS = "gd_seguridad_v1", SS = "gd_sesion_v1", HORAS = 8;

  /* ---------- utilidades de cifrado (solo modo local) ---------- */
  function hex(u8){
    var s = "";
    for(var i=0;i<u8.length;i++) s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16);
    return s;
  }
  function desdeHex(h){
    var u = new Uint8Array(h.length/2);
    for(var i=0;i<u.length;i++) u[i] = parseInt(h.substr(i*2,2),16);
    return u;
  }
  function sal(){
    var u = new Uint8Array(16);
    if(window.crypto && crypto.getRandomValues) crypto.getRandomValues(u);
    else for(var i=0;i<16;i++) u[i] = Math.floor(Math.random()*256);
    return hex(u);
  }
  function repliegue(txt, rondas){          // solo si el navegador no ofrece PBKDF2
    var a = 0x811c9dc5, b = 0x1000193;
    for(var r=0;r<rondas;r++){
      for(var i=0;i<txt.length;i++){
        a = (a ^ txt.charCodeAt(i)) >>> 0;
        a = (a * 16777619) >>> 0;
        b = (b + a + r) >>> 0;
        b = ((b << 5) | (b >>> 27)) >>> 0;
      }
    }
    return "r1:" + a.toString(16) + b.toString(16);
  }
  async function resumen(clave, salHex, iter){
    if(window.crypto && crypto.subtle && crypto.subtle.importKey){
      try{
        var k = await crypto.subtle.importKey("raw", new TextEncoder().encode(clave),
                                              { name:"PBKDF2" }, false, ["deriveBits"]);
        var b = await crypto.subtle.deriveBits(
          { name:"PBKDF2", salt: desdeHex(salHex), iterations: iter, hash:"SHA-256" }, k, 256);
        return "p256:" + hex(new Uint8Array(b));
      }catch(e){ /* sigue al repliegue */ }
    }
    return repliegue(clave + "|" + salHex, 2000);
  }

  /* ---------- almacenamiento local ---------- */
  function leerCfg(){
    try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch(e){ return null; }
  }
  function guardarCfg(c){
    try { localStorage.setItem(LS, JSON.stringify(c)); return true; } catch(e){ return false; }
  }
  function sesionLocal(){
    try{
      var s = JSON.parse(sessionStorage.getItem(SS) || "null");
      if(s && s.exp > Date.now()) return s;
    }catch(e){}
    return null;
  }
  function abrirSesionLocal(u){
    try { sessionStorage.setItem(SS, JSON.stringify({ usuario:u, exp: Date.now() + HORAS*3600*1000 })); }
    catch(e){}
  }
  function cerrarSesionLocal(){
    try { sessionStorage.removeItem(SS); } catch(e){}
  }

  /* ---------- pantalla ---------- */
  /* Ajusta los textos de la pantalla de alta según dónde se va a crear la cuenta:
     en el servidor de la nube (primer administrador) o solo en este navegador. */
  function textosAlta(){
    if(modo === "api"){
      $("altaTitulo").textContent = "Crea el primer administrador";
      $("altaSub").textContent = "Esta aplicaci\u00f3n todav\u00eda no tiene ninguna cuenta. La primera que crees ser\u00e1 la de administrador y podr\u00e1 dar acceso al resto del equipo.";
      $("altaNota").textContent = "La cuenta se guarda en el servidor de la nube, con la contrase\u00f1a cifrada. En cuanto exista este administrador, esta pantalla desaparece y nadie m\u00e1s podr\u00e1 crearse una cuenta por su cuenta.";
      $("btnAlta").textContent = "Crear administrador y entrar";
      $("lineaVolverLogin").hidden = false;
    } else {
      $("altaTitulo").textContent = "Protege esta aplicaci\u00f3n";
      $("altaSub").textContent = "Es la primera vez que se abre en este equipo. Crea un usuario y una contrase\u00f1a para bloquear el acceso.";
      $("altaNota").textContent = "Sin servidor central, la contrase\u00f1a se guarda cifrada (resumen PBKDF2) en este navegador y el bloqueo es disuasorio: impide el uso casual, pero no cifra los PDF. Para seguridad real usa el servidor central.";
      $("btnAlta").textContent = "Guardar y entrar";
      $("lineaVolverLogin").hidden = true;
    }
  }
  function verGate(alta, aviso, tipo){
    mostrandoAlta = !!alta;
    if(alta) textosAlta();
    /* El atajo para crear el primer administrador solo aparece cuando el
       servidor confirma que todavía no existe ninguna cuenta. */
    $("lineaPrimer").hidden = !(modo === "api" && instalar);
    $("gAlta").hidden = !alta;
    $("gLogin").hidden = !!alta;
    $("gate").hidden = false;
    document.body.classList.add("noscroll");
    say($(alta ? "msgAlta" : "msgLogin"), aviso || "", tipo || (aviso ? "err" : ""));
    setTimeout(function(){ (alta ? $("altaUsuario") : $("inUsuario")).focus(); }, 60);
  }
  function cerrarGate(){
    $("gate").hidden = true;
    document.body.classList.remove("noscroll");
    $("inClave").value = "";
  }
  function pintarBarra(){
    var w = $("who");
    if(!usuario){ w.hidden = true; return; }
    w.hidden = false;
    /* En modo local se ocultan botones de contraseña y salir (acceso directo) */
    $("btnClave").hidden = modo !== "api";
    $("btnSalir").hidden = modo !== "api";
    $("btnUsuarios").hidden = !(modo === "api" && rol === "admin");
    $("whoTxt").textContent = modo === "api"
      ? usuario + (rol ? " · " + rol : "")
      : "";
  }

  /* ---------- servidor ---------- */
  async function pedir(url, datos){
    var o = { method: datos ? "POST" : "GET", credentials:"same-origin" };
    if(datos){ o.headers = { "Content-Type":"application/json" }; o.body = JSON.stringify(datos); }
    var r = await fetch(url, o), t = await r.text(), j = null;
    try { j = t ? JSON.parse(t) : null; } catch(e){ j = null; }
    return { status: r.status, datos: j };
  }

  async function entrarServidor(u, c){
    var r = await pedir("api/login", { usuario:u, clave:c });
    if(r.status === 409 && r.datos && r.datos.instalar){
      instalar = true;
      verGate(true, "Todav\u00eda no hay ninguna cuenta: crea aqu\u00ed el primer administrador.", "");
      return { ok:false, error:"" };
    }
    if(r.status === 200 && r.datos && r.datos.ok){
      instalar = false;
      usuario = r.datos.usuario; rol = r.datos.rol || "";
      return { ok:true };
    }
    return { ok:false, error: (r.datos && r.datos.error) || "No se pudo iniciar sesión (error " + r.status + ")." };
  }

  async function entrarLocal(u, c){
    var cfg = leerCfg();
    if(!cfg) return { ok:false, error:"Todavía no hay una contraseña definida en este equipo." };
    var h = await resumen(c, cfg.sal, cfg.iter || 150000);
    var uOk = String(u||"").trim().toLowerCase() === cfg.usuario;
    if(!uOk || h !== cfg.hash){
      return { ok:false, error:"Usuario o contraseña incorrectos." };
    }
    usuario = cfg.usuario; rol = cfg.rol || "responsable";
    abrirSesionLocal(usuario);
    return { ok:true };
  }

  /* ---------- API pública del módulo ---------- */
  return {
    get modo(){ return modo; },
    get usuario(){ return usuario; },
    get rol(){ return rol; },
    get esAdmin(){ return modo === "api" && rol === "admin"; },
    get hayQueInstalar(){ return instalar; },
    pedir: pedir,
    verLogin: function(aviso, tipo){ verGate(false, aviso || "", tipo || ""); },
    verAlta: function(aviso, tipo){ verGate(true, aviso || "", tipo || ""); },

    /* Devuelve una promesa que se resuelve cuando hay acceso concedido. */
    iniciar: function(m){
      modo = m;
      promesa = new Promise(function(res){ resolver = res; });
      (async function(){
        if(modo === "api"){
          var r = await pedir("api/yo");
          if(r.status === 200 && r.datos && r.datos.instalar){
            instalar = true;
            verGate(true, "");
            return;
          }
          if(r.status === 200 && r.datos && r.datos.usuario){
            usuario = r.datos.usuario; rol = r.datos.rol || "";
            pintarBarra(); cerrarGate(); resolver();
            return;
          }
          $("notaLogin").textContent = "Tus documentos están guardados en la nube. Si olvidaste tu contraseña, pídele al administrador que la restablezca.";
          verGate(false, "");
          return;
        }
        /* modo local: acceso directo sin contraseña */
        usuario = "usuario-local"; rol = "responsable";
        pintarBarra(); cerrarGate(); resolver();
      })();
      return promesa;
    },

    /* Sesión inválida detectada en cualquier petición al servidor. */
    caducada: function(){
      usuario = ""; rol = "";
      cerrarSesionLocal();
      pintarBarra();
      if($("gate").hidden) verGate(false, "Tu sesión terminó por seguridad. Vuelve a iniciar sesión.", "err");
    },

    entrar: async function(u, c){
      if(!String(u||"").trim() || !String(c||"")) return { ok:false, error:"Escribe tu usuario y tu contraseña." };
      var r = modo === "api" ? await entrarServidor(u, c) : await entrarLocal(u, c);
      if(r.ok){ pintarBarra(); cerrarGate(); if(resolver) resolver(); }
      return r;
    },

    /* Alta de la primera cuenta: en la nube crea el administrador en el
       servidor; sin servidor solo bloquea este navegador. */
    crearPrimero: async function(u, c){
      if(modo !== "api") return SEG.crearLocal(u, c);
      u = String(u||"").trim().toLowerCase();
      if(!/^[a-z0-9._-]{3,32}$/.test(u)) return { ok:false, error:"El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo." };
      var f = SEG.fuerza(c);
      if(f.nivel === "b") return { ok:false, error: f.aviso };
      var r = await pedir("api/primer-admin", { usuario:u, clave:c });
      if(r.status === 200 && r.datos && r.datos.ok){
        instalar = false;
        usuario = r.datos.usuario; rol = r.datos.rol || "admin";
        pintarBarra(); cerrarGate(); if(resolver) resolver();
        return { ok:true };
      }
      if(r.status === 403){
        instalar = false;
        verGate(false, (r.datos && r.datos.error) || "Ya hay usuarios creados.", "err");
        return { ok:false, error:"" };
      }
      return { ok:false, error:(r.datos && r.datos.error) || "No se pudo crear el administrador (error " + r.status + ")." };
    },

    crearLocal: async function(u, c){
      u = String(u||"").trim().toLowerCase();
      if(!/^[a-z0-9._-]{3,32}$/.test(u)) return { ok:false, error:"El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo." };
      var f = SEG.fuerza(c);
      if(f.nivel === "b") return { ok:false, error: f.aviso };
      var s = sal(), it = 150000;
      var h = await resumen(c, s, it);
      var ok = guardarCfg({ usuario:u, rol:"responsable", sal:s, iter:it, hash:h, creado:Date.now(),
                            debil: h.indexOf("r1:") === 0 });
      if(!ok) return { ok:false, error:"Este navegador no permite guardar la configuración (modo privado)." };
      usuario = u; rol = "responsable";
      abrirSesionLocal(u);
      pintarBarra(); cerrarGate(); if(resolver) resolver();
      return { ok:true };
    },

    cambiar: async function(act, nue){
      var f = SEG.fuerza(nue);
      if(f.nivel === "b") return { ok:false, error: f.aviso };
      if(modo === "api"){
        var r = await pedir("api/clave", { actual:act, nueva:nue });
        if(r.status === 200) return { ok:true, aviso:(r.datos && r.datos.aviso) || "Contraseña cambiada.", salir:true };
        return { ok:false, error:(r.datos && r.datos.error) || "No se pudo cambiar la contraseña." };
      }
      var cfg = leerCfg();
      if(!cfg) return { ok:false, error:"No hay una contraseña definida en este equipo." };
      var h = await resumen(act, cfg.sal, cfg.iter || 150000);
      if(h !== cfg.hash) return { ok:false, error:"La contraseña actual no es correcta." };
      var s = sal();
      cfg.sal = s; cfg.iter = 150000;
      cfg.hash = await resumen(nue, s, cfg.iter);
      cfg.debil = cfg.hash.indexOf("r1:") === 0;
      if(!guardarCfg(cfg)) return { ok:false, error:"No se pudo guardar la nueva contraseña." };
      return { ok:true, aviso:"Contraseña cambiada en este equipo.", salir:false };
    },

    salir: async function(){
      if(modo === "api"){ try { await pedir("api/logout", {}); } catch(e){} }
      cerrarSesionLocal();
      usuario = ""; rol = "";
      pintarBarra();
      verGate(false, "Sesión cerrada. Hasta pronto.", "ok");
    },

    fuerza: function(c){
      c = String(c || "");
      var letras = /[a-zA-Z]/.test(c), num = /\d/.test(c), otros = /[^a-zA-Z0-9]/.test(c);
      if(c.length < 8 || !letras || !num)
        return { nivel:"b", aviso:"La contraseña debe tener al menos 8 caracteres e incluir letras y números." };
      if(c.length >= 12 && otros) return { nivel:"f", aviso:"Contraseña fuerte." };
      return { nivel:"m", aviso:"Contraseña aceptable." };
    }
  };
})();

/* ------------------------------------------------------------------ *
 * Driver LOCAL (IndexedDB del navegador)
 * ------------------------------------------------------------------ */
var IDB = (function(){
  var dbp = null;
  function open(){
    if(dbp) return dbp;
    dbp = new Promise(function(res, rej){
      var rq = indexedDB.open("gestion_documental", 1);
      rq.onupgradeneeded = function(){
        var db = rq.result;
        if(!db.objectStoreNames.contains("lotes")) db.createObjectStore("lotes", { keyPath:"id" });
        if(!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath:"key" });
      };
      rq.onsuccess = function(){ res(rq.result); };
      rq.onerror = function(){ rej(rq.error); };
    });
    return dbp;
  }
  function tx(store, mode, fn){
    return open().then(function(db){
      return new Promise(function(res, rej){
        var t = db.transaction(store, mode), s = t.objectStore(store), out;
        out = fn(s);
        t.oncomplete = function(){ res(out && out.result !== undefined ? out.result : out); };
        t.onerror = function(){ rej(t.error); };
        t.onabort = function(){ rej(t.error); };
      });
    });
  }
  return {
    put:  function(l){ return tx("lotes","readwrite", function(s){ s.put(l); }); },
    get:  function(id){ return tx("lotes","readonly", function(s){ return s.get(id); }); },
    all:  function(){ return tx("lotes","readonly", function(s){ return s.getAll(); }); },
    del:  function(id){ return tx("lotes","readwrite", function(s){ s.delete(id); }); },
    putF: function(key, blob){ return tx("files","readwrite", function(s){ s.put({ key:key, blob:blob }); }); },
    getF: function(key){ return tx("files","readonly", function(s){ return s.get(key); }); },
    delF: function(keys){ return tx("files","readwrite", function(s){ keys.forEach(function(k){ s.delete(k); }); }); }
  };
})();

/* Carpeta real del equipo (solo navegadores con acceso al sistema de archivos).
   La carpeta que elige el usuario ES el destino: dentro de ella se crea
   únicamente la carpeta del lote, sin niveles intermedios inventados. */
async function carpetaDestino(lote, crear){
  if(!raiz) return null;
  return await raiz.getDirectoryHandle(lote.carpeta, { create: crear !== false });
}
async function escribirEnDisco(lote, nombre, file){
  var dir = await carpetaDestino(lote);
  if(!dir) return false;
  var fh = await dir.getFileHandle(nombre, { create:true });
  var w = await fh.createWritable();
  await w.write(file);
  await w.close();
  return true;
}
async function borrarDeDisco(lote){
  if(!raiz) return false;
  await raiz.removeEntry(lote.carpeta, { recursive:true });
  return true;
}

var Local = {
  async crear(l){
    var todos = (await IDB.all()) || [];
    var ya = todos.filter(function(x){
      return x.carpeta.toLowerCase() === l.carpeta.toLowerCase() && x.nit === l.nit;
    })[0];
    if(ya){
      try { await carpetaDestino(ya); } catch(e){}
      return { lote: ya, existia: true };
    }
    var lote = {
      id: "L" + Date.now() + Math.random().toString(36).slice(2,7),
      ruta: l.ruta, carpeta: l.carpeta, nit: l.nit, sep: l.sep,
      creado: Date.now(), docs: {}
    };
    await IDB.put(lote);
    try { await carpetaDestino(lote); }
    catch(e){ throw new Error("no se pudo crear la carpeta en el equipo (" + e.message + ")"); }
    return { lote: lote, existia: false };
  },
  async guardar(loteId, sigla, file, info){
    var lote = await IDB.get(loteId);
    if(!lote) throw new Error("El lote ya no existe en la base de datos local.");
    var nombre = nombreArchivo(sigla, lote.nit, lote.carpeta, lote.sep);
    await IDB.putF(loteId + "|" + sigla, file);
    var enDisco = false;
    try { enDisco = await escribirEnDisco(lote, nombre, file); } catch(e){ enDisco = false; }
    lote.docs[sigla] = { nombre: nombre, size: file.size, ts: Date.now(),
                         original: (info && info.original) || file.name || "",
                         partes: (info && info.partes) || 1,
                         paginas: (info && info.paginas) || 0,
                         disco: enDisco };
    await IDB.put(lote);
    return lote;
  },
  async lista(){ return ((await IDB.all()) || []).sort(function(a,b){ return b.creado - a.creado; }); },
  async blob(loteId, sigla){
    var r = await IDB.getF(loteId + "|" + sigla);
    return r ? r.blob : null;
  },
  async eliminar(lote, tambienDisco){
    await IDB.delF(SIGLAS.map(function(s){ return lote.id + "|" + s; }));
    await IDB.del(lote.id);
    if(tambienDisco) await borrarDeDisco(lote);
  }
};

/* ------------------------------------------------------------------ *
 * Driver API (servidor central)
 * ------------------------------------------------------------------ */
async function jf(url, opt){
  var o = opt || {};
  o.credentials = "same-origin";
  var r = await fetch(url, o);
  var t = await r.text(), j = null;
  try { j = t ? JSON.parse(t) : null; } catch(e){ j = null; }
  if(r.status === 401){
    SEG.caducada();
    throw new Error((j && j.error) ? j.error : "Tu sesi\u00f3n expir\u00f3. Vuelve a iniciar sesi\u00f3n.");
  }
  if(!r.ok) throw new Error((j && j.error) ? j.error : ("Error " + r.status));
  return j;
}
var Api = {
  crear: function(l){
    return jf("api/lotes", {
      method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(l)
    });
  },
  guardar: function(loteId, sigla, file, info){
    return jf("api/lotes/" + encodeURIComponent(loteId) + "/docs/" + encodeURIComponent(sigla), {
      method:"POST",
      headers:{ "Content-Type":"application/pdf",
                "X-Original-Name": encodeURIComponent((info && info.original) || file.name || ""),
                "X-Partes": String((info && info.partes) || 1),
                "X-Paginas": String((info && info.paginas) || 0) },
      body: file
    }).then(function(r){ return r.lote; });
  },
  lista: function(){ return jf("api/lotes").then(function(r){ return r.lotes || []; }); },
  eliminar: function(lote){
    return jf("api/lotes/" + encodeURIComponent(lote.id), { method:"DELETE" });
  },
  blob: function(loteId, sigla){
    return fetch(Api.urlDoc(loteId, sigla), { credentials:"same-origin" }).then(function(r){
      if(r.status === 401){ SEG.caducada(); throw new Error("tu sesión expiró"); }
      if(!r.ok) throw new Error("el servidor respondió " + r.status);
      return r.blob();
    });
  },
  urlDoc: function(loteId, sigla){
    return "api/lotes/" + encodeURIComponent(loteId) + "/docs/" + encodeURIComponent(sigla);
  },
  urlZip: function(loteId){ return "api/lotes/" + encodeURIComponent(loteId) + "/zip"; },
  urlZipVarios: function(ids){ return "api/zip?ids=" + encodeURIComponent(ids.join(",")); }
};

var Store = Local;

function blobDoc(lote, sigla){
  return MODE === "api" ? Api.blob(lote.id, sigla) : Local.blob(lote.id, sigla);
}

/* ------------------------------------------------------------------ *
 * Unión de varios PDF en uno solo (motor propio, dentro del navegador)
 * ------------------------------------------------------------------ */
async function unirPendientes(sigla, nombreFinal){
  var files = pending[sigla] || [];
  if(!files.length) throw new Error("no hay archivos cargados");

  /* Si hay documento guardado en la casilla (Anexar), incluirlo en la fusión */
  var yaGuardado = activo && activo.docs && activo.docs[sigla];
  var todos = [];
  if(yaGuardado){
    try{
      var blobGuardado = await blobDoc(activo, sigla);
      if(blobGuardado){
        todos.push({ name: yaGuardado.nombre || (sigla + ".pdf"), blob: blobGuardado, isSaved: true });
      }
    } catch(e){ /* si no se puede leer, se pierde el anterior */ }
  }
  files.forEach(function(f){ todos.push({ name: f.name, file: f, isSaved: false }); });

  var originales = todos.map(function(f){ return f.name; }).join(" + ");
  if(todos.length === 1){
    var unico = todos[0].blob || todos[0].file;
    return { file: unico instanceof Blob ? conNombre(new Uint8Array(await unico.arrayBuffer()), nombreFinal) : unico, 
             partes: 1, paginas: 0, original: originales, fueAnexado: !!yaGuardado };
  }
  if(!window.PDFMerge) throw new Error("no se pudo cargar el motor de unión de PDF");
  var buffers = [];
  for(var i=0;i<todos.length;i++){
    var src = todos[i].blob || todos[i].file;
    buffers.push(new Uint8Array(await src.arrayBuffer()));
  }
  var r = window.PDFMerge.merge(buffers, todos.map(function(f){ return f.name; }));
  return { file: conNombre(r.bytes, nombreFinal), partes: todos.length,
           paginas: r.paginas, original: originales, fueAnexado: !!yaGuardado };
}

/* ------------------------------------------------------------------ *
 * Pantalla A: formulario y cajas de carga
 * ------------------------------------------------------------------ */
function vistaPrevia(){
  var nit = limpia($("nit").value) || "NIT", car = limpia($("carpeta").value) || "Carpeta";
  $("vista").textContent = nombreArchivo("CRC", nit, car, $("sep").value);
}

function textoZona(sigla){
  var ya = activo && activo.docs && activo.docs[sigla];
  return ya
    ? "Documento guardado · arrastra PDF para anexar o reemplazar"
    : "Arrastra uno o varios PDF aquí, o haz clic para buscarlos";
}

function pintarLista(sigla){
  var cont = $("fl-" + sigla);
  if(!cont) return;
  var files = pending[sigla] || [];
  cont.textContent = "";
  if(!files.length) return;

  var cab = document.createElement("div");
  cab.className = "fcount";
  cab.textContent = files.length === 1
    ? "1 archivo en cola"
    : files.length + " archivos se unirán en un único PDF, en este orden:";
  cont.appendChild(cab);

  files.forEach(function(f, i){
    var it = document.createElement("div");
    it.className = "fitem";

    var num = document.createElement("span");
    num.className = "fnum"; num.textContent = (i+1);

    var nm = document.createElement("span");
    nm.className = "fname"; nm.textContent = f.name;
    nm.title = f.name + "  ·  " + human(f.size);

    var sz = document.createElement("span");
    sz.className = "fsize"; sz.textContent = human(f.size);

    var up = document.createElement("button");
    up.type = "button"; up.className = "fbtn"; up.textContent = "↑";
    up.title = "Subir este archivo en el orden";
    up.disabled = i === 0;
    up.addEventListener("click", function(){ mover(sigla, i, -1); });

    var dn = document.createElement("button");
    dn.type = "button"; dn.className = "fbtn"; dn.textContent = "↓";
    dn.title = "Bajar este archivo en el orden";
    dn.disabled = i === files.length - 1;
    dn.addEventListener("click", function(){ mover(sigla, i, 1); });

    var rm = document.createElement("button");
    rm.type = "button"; rm.className = "fbtn del"; rm.textContent = "✕";
    rm.title = "Quitar este archivo de la cola";
    rm.addEventListener("click", function(){ quitar(sigla, i); });

    it.appendChild(num); it.appendChild(nm); it.appendChild(sz);
    it.appendChild(up); it.appendChild(dn); it.appendChild(rm);
    cont.appendChild(it);
  });
}

function pintarCajas(){
  var cont = $("boxes");
  cont.textContent = "";
  DOCS.forEach(function(d){
    var box = document.createElement("div");
    box.className = "box"; box.id = "box-" + d.sigla;

    var head = document.createElement("div"); head.className = "bhead";
    var ico = document.createElement("div"); ico.className = "ico"; ico.textContent = "PDF";
    var wrap = document.createElement("div");
    var sg = document.createElement("div"); sg.className = "sigla"; sg.textContent = d.sigla;
    var ds = document.createElement("div"); ds.className = "desc"; ds.textContent = d.desc;
    wrap.appendChild(sg); wrap.appendChild(ds);
    head.appendChild(ico); head.appendChild(wrap);

    var zone = document.createElement("div");
    zone.className = "zone"; zone.id = "zone-" + d.sigla;
    zone.textContent = textoZona(d.sigla);

    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = "application/pdf,.pdf"; inp.multiple = true; inp.hidden = true;

    var flist = document.createElement("div");
    flist.className = "flist"; flist.id = "fl-" + d.sigla;

    var tgt = document.createElement("div"); tgt.className = "target"; tgt.id = "tgt-" + d.sigla;

    var row = document.createElement("div"); row.className = "brow";
    var st = document.createElement("span"); st.className = "state"; st.id = "st-" + d.sigla;
    st.textContent = "Sin archivo";
    var grupo = document.createElement("div"); grupo.className = "rowacts";
    var bv = document.createElement("button");
    bv.className = "mini ghost"; bv.type = "button"; bv.textContent = "Ver / Imprimir";
    bv.id = "bv-" + d.sigla; bv.disabled = true;
    var bt = document.createElement("button");
    bt.className = "mini"; bt.type = "button"; bt.textContent = "Procesar"; bt.disabled = true;
    bt.id = "bt-" + d.sigla;
    grupo.appendChild(bv); grupo.appendChild(bt);
    row.appendChild(st); row.appendChild(grupo);

    box.appendChild(head); box.appendChild(zone); box.appendChild(inp);
    box.appendChild(flist); box.appendChild(tgt); box.appendChild(row);
    cont.appendChild(box);

    zone.addEventListener("click", function(){ inp.click(); });
    inp.addEventListener("change", function(e){
      if(e.target.files && e.target.files.length) tomar(d.sigla, e.target.files);
      e.target.value = "";
    });
    ["dragenter","dragover"].forEach(function(ev){
      box.addEventListener(ev, function(e){ e.preventDefault(); box.classList.add("hot"); });
    });
    ["dragleave","dragend","drop"].forEach(function(ev){
      box.addEventListener(ev, function(){ box.classList.remove("hot"); });
    });
    box.addEventListener("drop", function(e){
      e.preventDefault();
      if(e.dataTransfer.files && e.dataTransfer.files.length) tomar(d.sigla, e.dataTransfer.files);
    });
    bt.addEventListener("click", function(){ procesar([d.sigla]); });
    bv.addEventListener("click", function(){ verCasilla(d.sigla); });
  });
}

/* --- Modal Anexar / Reemplazar --- */
var _pendingModal = null; // { sigla, arr }

function mostrarModalAR(sigla, arr){
  var ya = activo && activo.docs && activo.docs[sigla];
  var info = ya ? ya.nombre : sigla;
  var incoming = arr.length === 1 ? "1 archivo nuevo" : arr.length + " archivos nuevos";
  var txt = "La casilla <strong>" + sigla + "</strong> ya tiene un documento guardado (<strong>" + info + "</strong>).<br>" +
    "Estás intentando agregar " + incoming + ".<br><br>" +
    "<strong>Anexar</strong>: los nuevos PDF se juntan con el documento existente (se fusionan al procesar).<br>" +
    "<strong>Reemplazar</strong>: se elimina el documento actual y se queda solo el nuevo.";
  $("modalRA-text").innerHTML = txt;
  _pendingModal = { sigla: sigla, arr: arr };
  $("modalRA").hidden = false;
  document.body.classList.add("noscroll");
}

function cerrarModalAR(){
  $("modalRA").hidden = true;
  document.body.classList.remove("noscroll");
  _pendingModal = null;
}

/* --- Fin modal --- */

function tomar(sigla, lista){
  var st = $("st-" + sigla);
  var añadidos = 0, rechazados = [];
  var validos = [];
  for(var i=0;i<lista.length;i++){
    var f = lista[i];
    if(!esPdf(f)){ rechazados.push(f.name); continue; }
    validos.push(f);
    añadidos++;
  }
  if(!validos.length){
    st.textContent = "Solo se aceptan archivos PDF";
    st.className = "state err";
    return;
  }

  /* Si la casilla ya tiene documento guardado, preguntar Anexar o Reemplazar */
  var yaGuardado = activo && activo.docs && activo.docs[sigla];
  if(yaGuardado){
    mostrarModalAR(sigla, validos);
    return;
  }

  /* Si ya hay PDF en cola, simplemente se agregan (comportamiento normal) */
  if(!pending[sigla]) pending[sigla] = [];
  validos.forEach(function(f){ pending[sigla].push(f); });
  if(!pending[sigla].length) delete pending[sigla];

  var n = (pending[sigla] || []).length;
  var zone = $("zone-" + sigla);
  zone.classList.toggle("has", n > 0);
  zone.textContent = n
    ? (n === 1 ? "1 PDF en cola · clic para añadir más" : n + " PDF en cola · clic para añadir más")
    : textoZona(sigla);

  if(rechazados.length){
    st.textContent = "Listo para procesar · se ignoraron " + rechazados.length + " archivo(s) que no son PDF";
    st.className = "state err";
  } else if(n){
    st.textContent = n === 1 ? "Listo para procesar" : "Listo: se unirán " + n + " PDF en uno solo";
    st.className = "state";
  }
  pintarLista(sigla);
  refrescarObjetivos();
  botones();
}

function quitar(sigla, i){
  if(!pending[sigla]) return;
  pending[sigla].splice(i, 1);
  if(!pending[sigla].length) delete pending[sigla];
  var n = (pending[sigla] || []).length;
  var zone = $("zone-" + sigla);
  zone.classList.toggle("has", n > 0);
  zone.textContent = n ? n + " PDF en cola · clic para añadir más" : textoZona(sigla);
  var st = $("st-" + sigla);
  if(n){
    st.textContent = n === 1 ? "Listo para procesar" : "Listo: se unirán " + n + " PDF en uno solo";
    st.className = "state";
  } else {
    var ya = activo && activo.docs && activo.docs[sigla];
    st.textContent = ya ? "Guardado" : "Sin archivo";
    st.className = "state" + (ya ? " ok" : "");
  }
  pintarLista(sigla);
  refrescarObjetivos();
  botones();
}

function mover(sigla, i, paso){
  var a = pending[sigla];
  if(!a) return;
  var j = i + paso;
  if(j < 0 || j >= a.length) return;
  var t = a[i]; a[i] = a[j]; a[j] = t;
  pintarLista(sigla);
}

function refrescarObjetivos(){
  DOCS.forEach(function(d){
    var t = $("tgt-" + d.sigla);
    if(!t) return;
    var enCola = (pending[d.sigla] || []).length;
    if(activo && (enCola || (activo.docs && activo.docs[d.sigla]))){
      var guardado = activo.docs && activo.docs[d.sigla];
      var nom = guardado ? guardado.nombre : nombreArchivo(d.sigla, activo.nit, activo.carpeta, activo.sep);
      t.textContent = "→ " + nom + (enCola > 1 ? "  (unión de " + enCola + " archivos)" : "");
    } else {
      t.textContent = "";
    }
  });
}

function botones(){
  var hayLote = !!activo;
  var hayPend = Object.keys(pending).length > 0;
  DOCS.forEach(function(d){
    var b = $("bt-" + d.sigla);
    if(b) b.disabled = !(hayLote && (pending[d.sigla] || []).length);
    var v = $("bv-" + d.sigla);
    if(v) v.disabled = !((pending[d.sigla] || []).length || (hayLote && activo.docs && activo.docs[d.sigla]));
  });
  $("btnTodo").disabled = !(hayLote && hayPend);
  $("btnZipA").disabled = !(hayLote && activo.docs && Object.keys(activo.docs).length > 0);
}

function pintarActivo(){
  var box = $("activo");
  if(!activo){ box.className = "active-lote"; box.textContent = ""; return; }
  box.className = "active-lote on";
  box.textContent = "";
  var l1 = document.createElement("div");
  l1.appendChild(document.createTextNode("Lote activo: "));
  var b = document.createElement("b"); b.textContent = activo.carpeta;
  l1.appendChild(b);
  l1.appendChild(document.createTextNode("  ·  NIT " + activo.nit + "  ·  " +
    Object.keys(activo.docs || {}).length + " de 6 documentos guardados"));
  var l2 = document.createElement("div");
  l2.className = "mono"; l2.style.fontSize = "12px"; l2.style.color = "var(--dim)";
  l2.style.marginTop = "4px";
  l2.textContent = MODE === "api"
    ? "Guardado en la nube · carpeta “" + activo.carpeta + "”"
    : "Destino: " + destino(activo);
  box.appendChild(l1); box.appendChild(l2);
  DOCS.forEach(function(d){
    var s = document.createElement("span");
    s.className = "sig" + ((activo.docs && activo.docs[d.sigla]) ? " on" : "");
    s.textContent = d.sigla;
    box.appendChild(s);
  });
}

/* Refresca las 6 casillas según el lote activo */
function refrescarCajas(){
  DOCS.forEach(function(d){
    var ya = activo && activo.docs && activo.docs[d.sigla];
    var n = (pending[d.sigla] || []).length;
    var zone = $("zone-" + d.sigla);
    zone.classList.toggle("has", n > 0);
    zone.textContent = n ? n + " PDF en cola · clic para añadir más" : textoZona(d.sigla);
    var st = $("st-" + d.sigla);
    if(n){
      st.textContent = n === 1 ? "Listo para procesar" : "Listo: se unirán " + n + " PDF en uno solo";
      st.className = "state";
    } else {
      st.textContent = ya ? "Guardado" : "Sin archivo";
      st.className = "state" + (ya ? " ok" : "");
    }
    $("box-" + d.sigla).classList.toggle("done", !!ya);
    pintarLista(d.sigla);
  });
}

/* Crear carpeta / lote */
$("btnCrear").addEventListener("click", async function(){
  /* En la nube nunca se pide una carpeta del equipo. */
  var ruta = MODE === "api" ? "" : limpiaRuta($("ruta").value);
  var carpeta = limpia($("carpeta").value);
  var nit = limpia($("nit").value);
  $("carpeta").classList.toggle("bad", !carpeta);
  $("nit").classList.toggle("bad", !/^\d{5,15}$/.test(nit));
  if(!carpeta){ say($("msgA"), "Escribe el nombre de la carpeta o lote.", "err"); return; }
  if(!/^\d{5,15}$/.test(nit)){ say($("msgA"), "El NIT de la IPS debe ser numérico (entre 5 y 15 dígitos).", "err"); return; }
  $("ruta").value = ruta;
  try{
    var r = await Store.crear({ ruta:ruta, carpeta:carpeta, nit:nit, sep:$("sep").value });
    activo = r.lote;
    pending = {};
    refrescarCajas();
    say($("msgA"), r.existia
      ? "Esa carpeta ya existía para el NIT indicado: se reabrió para seguir cargando documentos."
      : (MODE === "api"
          ? "Carpeta “" + carpeta + "” creada en la nube. Ya puedes cargar los seis documentos: quedan guardados en el servidor."
          : (raiz
            ? "Carpeta “" + carpeta + "” creada dentro de " + (ruta || raiz.name) + " y registrada en el histórico."
            : "Carpeta “" + carpeta + "” registrada con destino " + destino(activo) + ". Usa “Elegir carpeta de destino” si quieres que los PDF se guarden solos ahí.")), "ok");
    pintarActivo(); refrescarObjetivos(); botones(); cargarTabla();
  }catch(e){
    say($("msgA"), "No se pudo crear la carpeta: " + e.message, "err");
  }
});

$("btnNuevo").addEventListener("click", function(){
  activo = null; pending = {};
  $("carpeta").value = ""; $("carpeta").classList.remove("bad"); $("nit").classList.remove("bad");
  refrescarCajas();
  say($("msgA"), ""); say($("msgP"), "");
  pintarActivo(); refrescarObjetivos(); botones(); vistaPrevia();
});

/* Elegir la carpeta de destino en el equipo (solo cuando NO hay servidor en
   la nube: allí los documentos se guardan directamente en el servidor). */
if(HAY_FS){
  $("btnRaiz").addEventListener("click", async function(){
    try{
      raiz = await window.showDirectoryPicker({ mode:"readwrite" });
      $("ruta").value = raiz.name;
      $("raizTxt").textContent = "Guardando en la carpeta “" + raiz.name +
        "” que elegiste. Dentro se creará solo la carpeta del lote.";
      say($("msgA"), "Carpeta de destino lista: " + raiz.name +
        ". Escribe el nombre del lote y el NIT, y pulsa “Crear carpeta”.", "ok");
    }catch(e){
      if(e && e.name !== "AbortError") say($("msgA"), "No se pudo usar esa carpeta: " + e.message, "err");
    }
  });
}

/* Ajusta la zona de destino segun el modo detectado. */
function configurarDestino(){
  if(MODE === "api"){
    /* Todo vive en la nube: no se pide ninguna carpeta del equipo. */
    $("campoRuta").hidden = true;
    $("btnRaiz").hidden = true;
    $("raizTxt").hidden = false;
    $("raizTxt").textContent = "Los documentos se guardan en la nube, dentro de la carpeta del lote. " +
      "No hace falta elegir ninguna carpeta de tu computador: entra desde cualquier equipo con tu usuario y ahí estarán.";
    return;
  }
  $("campoRuta").hidden = false;
  $("raizTxt").hidden = false;
  if(HAY_FS){
    $("btnRaiz").hidden = false;
    $("raizTxt").textContent = "Elige la carpeta donde quieres guardar. El sistema creará dentro de ella únicamente la carpeta del lote, sin añadir ningún otro nivel.";
  } else {
    $("btnRaiz").hidden = true;
    $("raizTxt").textContent = "Escribe aquí la ruta donde guardas los lotes (por ejemplo C:\\Users\\JORGE\\Documents\\PROYECT). Para que el sistema guarde los PDF solo, abre la aplicación en Chrome o Edge de escritorio y usa el botón de elegir carpeta.";
  }
}

/* Procesar (individual o masivo): une los PDF de cada casilla y guarda uno solo */
async function procesar(siglas){
  if(!activo){ say($("msgP"), "Primero crea la carpeta del lote.", "err"); return; }
  var lista = siglas.filter(function(s){ return (pending[s] || []).length; });
  if(!lista.length){ say($("msgP"), "No hay archivos cargados para procesar.", "err"); return; }
  say($("msgP"), "Procesando " + lista.length + " documento(s)…");
  var okN = 0, fail = [], unidos = 0;
  for(var i=0;i<lista.length;i++){
    var sg = lista[i];
    var st = $("st-" + sg);
    try{
      var cuantos = pending[sg].length;
      if(cuantos > 1){
        st.textContent = "Uniendo " + cuantos + " archivos…";
        st.className = "state";
      }
      var nombreFinal = nombreArchivo(sg, activo.nit, activo.carpeta, activo.sep);
      var res = await unirPendientes(sg, nombreFinal);
      var lote = await Store.guardar(activo.id, sg, res.file,
        { original: res.original, partes: res.partes, paginas: res.paginas });
      activo = lote;
      delete pending[sg];
      var info = lote.docs[sg] || {};
      var extra = res.partes > 1
        ? "  ·  " + res.partes + " archivos unidos" + (res.paginas ? " (" + res.paginas + " páginas)" : "")
        : "";
      st.textContent = "Guardado como " + (info.nombre || nombreFinal) +
        (info.disco ? " (en tu carpeta)" : "") + extra;
      st.className = "state ok";
      $("box-" + sg).classList.add("done");
      $("zone-" + sg).classList.remove("has");
      $("zone-" + sg).textContent = textoZona(sg);
      pintarLista(sg);
      if(res.partes > 1) unidos++;
      okN++;
    }catch(e){
      fail.push(sg + ": " + e.message);
      st.textContent = "Error al guardar: " + e.message;
      st.className = "state err";
    }
  }
  say($("msgP"),
    okN + " documento(s) renombrado(s) y guardado(s)." +
    (unidos ? "  " + unidos + " casilla(s) quedó con sus PDF unidos en un único archivo." : "") +
    (fail.length ? "  Fallaron: " + fail.join(" | ") : ""),
    fail.length ? "err" : "ok");
  pintarActivo(); refrescarObjetivos(); botones(); cargarTabla();
}

$("btnTodo").addEventListener("click", function(){
  procesar(SIGLAS.slice());
});
$("btnZipA").addEventListener("click", function(){
  if(activo) zipLote(activo, $("msgP"));
});

["nit","carpeta","sep"].forEach(function(id){
  $(id).addEventListener("input", vistaPrevia);
  $(id).addEventListener("change", vistaPrevia);
});

/* ------------------------------------------------------------------ *
 * Vista previa e impresión
 * ------------------------------------------------------------------ */
var visURL = null, visBlob = null, visNombre = "";

function cerrarVista(){
  $("ov").hidden = true;
  $("ovFrame").removeAttribute("src");
  if(visURL){ URL.revokeObjectURL(visURL); visURL = null; }
  visBlob = null; visNombre = "";
  document.body.classList.remove("noscroll");
}

function abrirVista(titulo, sub){
  $("ovTitle").textContent = titulo;
  $("ovSub").textContent = sub || "";
  $("ov").hidden = false;
  document.body.classList.add("noscroll");
  $("ovMsg").textContent = "Cargando documento…";
  $("ovPrint").disabled = true;
  $("ovDown").disabled = true;
}

function mostrarBlob(blob, nombre, nota){
  if(visURL) URL.revokeObjectURL(visURL);
  visBlob = blob; visNombre = nombre;
  visURL = URL.createObjectURL(new Blob([blob], { type:"application/pdf" }));
  $("ovFrame").setAttribute("src", visURL);
  $("ovMsg").textContent = nota || "";
  $("ovPrint").disabled = false;
  $("ovDown").disabled = false;
}

async function verDoc(lote, sigla){
  var info = (lote.docs || {})[sigla] || {};
  abrirVista("Vista previa · " + sigla, info.nombre || "");
  try{
    var b = await blobDoc(lote, sigla);
    if(!b) throw new Error("el documento no está disponible");
    var nota = "Lote " + lote.carpeta + " · " + human(b.size) +
      (info.partes > 1 ? " · unión de " + info.partes + " archivos" : "") +
      (info.paginas ? " · " + info.paginas + " páginas" : "");
    mostrarBlob(b, info.nombre || (sigla + ".pdf"), nota);
  }catch(e){
    $("ovMsg").textContent = "No se pudo abrir la vista previa: " + e.message;
  }
}

/* Vista previa desde una casilla de la Pantalla A:
   si hay PDF en cola muestra cómo quedará el archivo unido (sin guardarlo);
   si no, muestra el documento ya guardado. */
async function verCasilla(sigla){
  var enCola = (pending[sigla] || []).length;
  if(!enCola){
    if(activo && activo.docs && activo.docs[sigla]) return verDoc(activo, sigla);
    return;
  }
  var nombreFinal = activo
    ? nombreArchivo(sigla, activo.nit, activo.carpeta, activo.sep)
    : sigla + ".pdf";
  abrirVista("Vista previa · " + sigla, nombreFinal + "  (borrador, aún sin guardar)");
  try{
    var res = await unirPendientes(sigla, nombreFinal);
    var nota = enCola > 1
      ? "Resultado de unir " + res.partes + " archivos" +
        (res.paginas ? " · " + res.paginas + " páginas" : "") + " · todavía no se ha guardado"
      : "Archivo tal como se guardará · todavía no se ha guardado";
    mostrarBlob(res.file, nombreFinal, nota);
  }catch(e){
    $("ovMsg").textContent = "No se pudo preparar la vista previa: " + e.message;
  }
}

$("ovClose").addEventListener("click", cerrarVista);
$("ovBack").addEventListener("click", cerrarVista);
$("ovDown").addEventListener("click", function(){
  if(visBlob) descarga(visBlob, visNombre || "documento.pdf");
});
$("ovPrint").addEventListener("click", function(){
  var fr = $("ovFrame");
  try{
    fr.contentWindow.focus();
    fr.contentWindow.print();
    $("ovMsg").textContent = "Se abrió el cuadro de impresión del navegador.";
  }catch(e){
    if(visURL){
      window.open(visURL, "_blank");
      $("ovMsg").textContent = "El documento se abrió en otra pestaña: usa Imprimir desde ahí.";
    } else {
      $("ovMsg").textContent = "No se pudo abrir la impresión: " + e.message;
    }
  }
});
document.addEventListener("keydown", function(e){
  if(e.key === "Escape" && !$("ov").hidden) cerrarVista();
});

/* ------------------------------------------------------------------ *
 * Descargas
 * ------------------------------------------------------------------ */
async function zipLote(lote, msgEl){
  var siglas = Object.keys(lote.docs || {});
  if(!siglas.length){ say(msgEl, "Ese lote no tiene documentos cargados todavía.", "err"); return; }
  if(MODE === "api"){
    window.location.href = Api.urlZip(lote.id);
    say(msgEl, "Descargando el ZIP del lote desde el servidor…", "ok");
    return;
  }
  say(msgEl, "Generando ZIP…");
  try{
    var items = [];
    for(var i=0;i<siglas.length;i++){
      var b = await Local.blob(lote.id, siglas[i]);
      if(b) items.push({ path: lote.carpeta + "/" + lote.docs[siglas[i]].nombre, blob: b });
    }
    var zip = await zipBlobs(items);
    descarga(zip, lote.carpeta + "_" + lote.nit + ".zip");
    say(msgEl, "ZIP listo: " + items.length + " documento(s) · " + human(zip.size) + ".", "ok");
  }catch(e){
    say(msgEl, "No se pudo generar el ZIP: " + e.message, "err");
  }
}

/* Descarga masiva: varios lotes dentro de un único ZIP, cada uno en su carpeta */
async function zipVarios(lotes, msgEl){
  var conDocs = lotes.filter(function(l){ return Object.keys(l.docs || {}).length; });
  if(!conDocs.length){ say(msgEl, "Los lotes seleccionados no tienen documentos para descargar.", "err"); return; }
  var sello = new Date(), p = function(n){ return (n<10?"0":"")+n; };
  var nombreZip = "Lotes_" + conDocs.length + "_" + sello.getFullYear() + p(sello.getMonth()+1) +
                  p(sello.getDate()) + "_" + p(sello.getHours()) + p(sello.getMinutes()) + ".zip";

  if(MODE === "api"){
    window.location.href = Api.urlZipVarios(conDocs.map(function(l){ return l.id; }));
    say(msgEl, "Descargando " + conDocs.length + " lote(s) en un ZIP desde el servidor…", "ok");
    return;
  }
  say(msgEl, "Generando el ZIP de " + conDocs.length + " lote(s)…");
  try{
    // Si dos lotes se llaman igual, se distinguen añadiendo el NIT a la carpeta.
    var veces = {};
    conDocs.forEach(function(l){
      var k = l.carpeta.toLowerCase();
      veces[k] = (veces[k] || 0) + 1;
    });
    var items = [], total = 0;
    for(var i=0;i<conDocs.length;i++){
      var l2 = conDocs[i];
      var base = veces[l2.carpeta.toLowerCase()] > 1 ? l2.carpeta + "_" + l2.nit : l2.carpeta;
      var sg = Object.keys(l2.docs);
      for(var j=0;j<sg.length;j++){
        var b = await Local.blob(l2.id, sg[j]);
        if(b){ items.push({ path: base + "/" + l2.docs[sg[j]].nombre, blob: b }); total++; }
      }
    }
    if(!items.length) throw new Error("no se encontraron los archivos en este navegador");
    var zip = await zipBlobs(items);
    descarga(zip, nombreZip);
    say(msgEl, "ZIP listo: " + conDocs.length + " lote(s), " + total + " documento(s) · " +
      human(zip.size) + ".", "ok");
  }catch(e){
    say(msgEl, "No se pudo generar el ZIP conjunto: " + e.message, "err");
  }
}

async function bajarDoc(lote, sigla, msgEl){
  if(MODE === "api"){ window.location.href = Api.urlDoc(lote.id, sigla); return; }
  var b = await Local.blob(lote.id, sigla);
  if(!b){ say(msgEl, "Ese documento no está disponible.", "err"); return; }
  descarga(b, lote.docs[sigla].nombre);
  say(msgEl, "Descargado " + lote.docs[sigla].nombre, "ok");
}

/* ------------------------------------------------------------------ *
 * Eliminar una carpeta o lote completo
 * ------------------------------------------------------------------ */
async function eliminarLote(lote, msgEl){
  var n = Object.keys(lote.docs || {}).length;
  var aviso = "Vas a eliminar la carpeta “" + lote.carpeta + "” (NIT " + lote.nit + ") con sus " +
    n + " documento(s) del histórico. Esta acción no se puede deshacer.\n\n¿Continuar?";
  if(!window.confirm(aviso)) return;
  var enDisco = false;
  if(MODE === "local" && raiz){
    enDisco = window.confirm("¿Borrar también la carpeta “" + lote.carpeta +
      "” y sus PDF de la carpeta de tu equipo?\n\nAceptar = borrar también del equipo.\n" +
      "Cancelar = borrar solo del histórico de la aplicación.");
  }
  say(msgEl, "Eliminando “" + lote.carpeta + "”…");
  try{
    if(MODE === "api") await Api.eliminar(lote);
    else await Local.eliminar(lote, enDisco);
    delete seleccion[lote.id];
    if(activo && activo.id === lote.id){
      activo = null; pending = {};
      refrescarCajas(); pintarActivo(); refrescarObjetivos(); botones();
      say($("msgA"), "El lote activo se eliminó. Crea o reabre otra carpeta para seguir.", "err");
    }
    await cargarTabla();
    say(msgEl, "Carpeta “" + lote.carpeta + "” eliminada" +
      (MODE === "api" ? " del servidor central." : (enDisco ? " del histórico y de tu equipo." : " del histórico.")), "ok");
  }catch(e){
    say(msgEl, "No se pudo eliminar: " + e.message, "err");
  }
}

/* ------------------------------------------------------------------ *
 * Pantalla B: consulta histórica
 * ------------------------------------------------------------------ */
var cacheLotes = [];
var visibles = [];

async function cargarTabla(){
  try{
    cacheLotes = await Store.lista();
    var vivos = {};
    cacheLotes.forEach(function(l){ vivos[l.id] = true; });
    Object.keys(seleccion).forEach(function(id){ if(!vivos[id]) delete seleccion[id]; });
    pintarTabla();
  }catch(e){
    say($("msgB"), "No se pudo leer la base de datos: " + e.message, "err");
  }
}

function marcados(){
  return visibles.filter(function(l){ return seleccion[l.id]; });
}

function refrescarBarraSel(){
  var m = marcados();
  var docs = m.reduce(function(a,l){ return a + Object.keys(l.docs||{}).length; }, 0);
  $("selTxt").textContent = m.length
    ? m.length + " lote(s) seleccionado(s) · " + docs + " documento(s)"
    : "Marca varios lotes para descargarlos juntos en un solo ZIP.";
  $("btnZipSel").disabled = !docs;
  $("btnLimpiaSel").disabled = !m.length;
  /* La copia completa solo tiene sentido (y permiso) con servidor central. */
  $("btnCopia").hidden = !SEG.esAdmin;
  var todos = visibles.length > 0 && m.length === visibles.length;
  var chAll = $("chAll");
  chAll.checked = todos;
  chAll.indeterminate = m.length > 0 && !todos;
}

function pintarTabla(){
  var q = $("q").value.trim().toLowerCase();
  var f = $("filtro").value;
  var rows = cacheLotes.filter(function(l){
    var n = Object.keys(l.docs || {}).length;
    if(f === "completos" && n < 6) return false;
    if(f === "incompletos" && n >= 6) return false;
    if(!q) return true;
    return l.carpeta.toLowerCase().indexOf(q) >= 0 || String(l.nit).indexOf(q) >= 0;
  });
  visibles = rows;

  var tb = $("tb");
  tb.textContent = "";
  var comp = cacheLotes.filter(function(l){ return Object.keys(l.docs||{}).length === 6; }).length;
  $("resumen").textContent = cacheLotes.length + " lote(s) · " + comp + " completo(s) · " +
    (cacheLotes.length - comp) + " pendiente(s)";

  if(!rows.length){
    var tr0 = document.createElement("tr"), td0 = document.createElement("td");
    td0.colSpan = 6; td0.className = "empty";
    td0.textContent = cacheLotes.length
      ? "Ningún lote coincide con la búsqueda."
      : "Aún no hay lotes registrados. Crea una carpeta en la Pantalla A.";
    tr0.appendChild(td0); tb.appendChild(tr0);
    refrescarBarraSel();
    return;
  }

  rows.forEach(function(l){
    var tr = document.createElement("tr");

    var td0 = document.createElement("td");
    td0.className = "cchk";
    var ch = document.createElement("input");
    ch.type = "checkbox";
    ch.className = "chk";
    ch.checked = !!seleccion[l.id];
    ch.title = "Seleccionar este lote para la descarga conjunta";
    ch.addEventListener("change", function(){
      if(ch.checked) seleccion[l.id] = true; else delete seleccion[l.id];
      tr.classList.toggle("selrow", ch.checked);
      refrescarBarraSel();
    });
    tr.classList.toggle("selrow", ch.checked);
    td0.appendChild(ch);

    var td1 = document.createElement("td");
    td1.textContent = fecha(l.creado);
    var ult = Object.keys(l.docs||{}).map(function(k){ return l.docs[k].ts; }).sort().pop();
    if(ult){
      var sm = document.createElement("div");
      sm.className = "prog"; sm.textContent = "Última carga: " + fecha(ult);
      td1.appendChild(sm);
    }

    var td2 = document.createElement("td");
    var nb = document.createElement("div"); nb.style.fontWeight = "600";
    nb.textContent = l.carpeta;
    var rt = document.createElement("div");
    rt.className = "prog mono"; rt.textContent = destino(l);
    td2.appendChild(nb); td2.appendChild(rt);

    var td3 = document.createElement("td");
    td3.className = "mono"; td3.textContent = l.nit;

    var td4 = document.createElement("td");
    var n = 0, unidos = 0;
    DOCS.forEach(function(d){
      var doc = l.docs && l.docs[d.sigla];
      if(doc){ n++; if(doc.partes > 1) unidos++; }
      var s = document.createElement("span");
      s.className = "sig" + (doc ? " on" : "");
      s.textContent = d.sigla;
      s.title = d.desc + (doc
        ? " · cargado" + (doc.partes > 1 ? " (unión de " + doc.partes + " archivos)" : "")
        : " · pendiente");
      td4.appendChild(s);
    });
    var pg = document.createElement("div");
    pg.className = "prog";
    pg.textContent = n + " de 6 " + (n === 6 ? "· completo" : "· faltan " + (6 - n)) +
      (unidos ? " · " + unidos + " casilla(s) con PDF unidos" : "");
    td4.appendChild(pg);

    var td5 = document.createElement("td");
    var acts = document.createElement("div"); acts.className = "rowacts";

    var selVer = document.createElement("select");
    var ov0 = document.createElement("option");
    ov0.value = ""; ov0.textContent = n ? "Ver / Imprimir…" : "Sin PDFs";
    selVer.appendChild(ov0);
    DOCS.forEach(function(d){
      if(l.docs && l.docs[d.sigla]){
        var op = document.createElement("option");
        op.value = d.sigla; op.textContent = d.sigla + " – " + l.docs[d.sigla].nombre;
        selVer.appendChild(op);
      }
    });
    selVer.disabled = n === 0;
    selVer.title = "Ver el documento antes de imprimirlo";
    selVer.addEventListener("change", function(){
      if(selVer.value){ verDoc(l, selVer.value); selVer.value = ""; }
    });

    var sel = document.createElement("select");
    var op0 = document.createElement("option");
    op0.value = ""; op0.textContent = n ? "Descargar PDF…" : "Sin PDFs";
    sel.appendChild(op0);
    DOCS.forEach(function(d){
      if(l.docs && l.docs[d.sigla]){
        var op = document.createElement("option");
        op.value = d.sigla; op.textContent = d.sigla + " – " + l.docs[d.sigla].nombre;
        sel.appendChild(op);
      }
    });
    sel.disabled = n === 0;
    sel.addEventListener("change", function(){
      if(sel.value){ bajarDoc(l, sel.value, $("msgB")); sel.value = ""; }
    });

    var bz = document.createElement("button");
    bz.className = "mini"; bz.type = "button"; bz.textContent = "ZIP";
    bz.title = "Descargar todo el lote en un ZIP";
    bz.disabled = n === 0;
    bz.addEventListener("click", function(){ zipLote(l, $("msgB")); });

    var bc = document.createElement("button");
    bc.className = "mini ghost"; bc.type = "button"; bc.textContent = "Continuar carga";
    bc.addEventListener("click", function(){
      activo = l; pending = {};
      $("ruta").value = l.ruta; $("carpeta").value = l.carpeta;
      $("nit").value = l.nit; $("sep").value = l.sep;
      refrescarCajas();
      verPantalla("A");
      vistaPrevia(); pintarActivo(); refrescarObjetivos(); botones();
      say($("msgA"), "Lote " + l.carpeta + " reabierto para completar documentos.", "ok");
    });

    var bd = document.createElement("button");
    bd.className = "mini danger"; bd.type = "button"; bd.textContent = "Eliminar";
    bd.title = "Eliminar esta carpeta y sus documentos";
    bd.addEventListener("click", function(){ eliminarLote(l, $("msgB")); });

    acts.appendChild(selVer); acts.appendChild(sel);
    acts.appendChild(bz); acts.appendChild(bc); acts.appendChild(bd);
    td5.appendChild(acts);

    [td0,td1,td2,td3,td4,td5].forEach(function(td){ tr.appendChild(td); });
    tb.appendChild(tr);
  });
  refrescarBarraSel();
}

$("q").addEventListener("input", pintarTabla);
$("filtro").addEventListener("change", pintarTabla);
$("btnRef").addEventListener("click", cargarTabla);
$("chAll").addEventListener("change", function(){
  var on = $("chAll").checked;
  visibles.forEach(function(l){
    if(on) seleccion[l.id] = true; else delete seleccion[l.id];
  });
  pintarTabla();
});
$("btnLimpiaSel").addEventListener("click", function(){
  seleccion = {};
  pintarTabla();
  say($("msgB"), "");
});
$("btnZipSel").addEventListener("click", function(){
  var m = marcados();
  if(!m.length){ say($("msgB"), "Marca primero los lotes que quieres descargar.", "err"); return; }
  zipVarios(m, $("msgB"));
});

/* Copia de seguridad completa: un solo ZIP con TODOS los PDF guardados en la
   nube más un inventario. Solo para administradores del servidor central. */
$("btnCopia").addEventListener("click", function(){
  if(!SEG.esAdmin){
    say($("msgB"), "Solo un administrador del servidor central puede descargar la copia completa.", "err");
    return;
  }
  window.location.href = "api/copia";
  say($("msgB"), "Preparando la copia completa (todos los documentos + inventario). " +
                 "Con muchos lotes puede tardar un rato; guárdala en un lugar seguro.", "ok");
});

/* ------------------------------------------------------------------ *
 * Eventos de la pantalla de acceso
 * ------------------------------------------------------------------ */
function bloquear(btn, on, txt){
  btn.disabled = !!on;
  if(on){ btn.dataset.t = btn.textContent; btn.textContent = txt || "Un momento…"; }
  else if(btn.dataset.t){ btn.textContent = btn.dataset.t; }
}

$("formLogin").addEventListener("submit", async function(e){
  e.preventDefault();
  var b = $("btnEntrar");
  say($("msgLogin"), "Verificando…");
  bloquear(b, true, "Verificando…");
  try{
    var r = await SEG.entrar($("inUsuario").value, $("inClave").value);
    if(!r.ok) say($("msgLogin"), r.error, "err");
    else say($("msgLogin"), "");
  }catch(err){
    say($("msgLogin"), "No se pudo verificar el acceso: " + err.message, "err");
  }
  bloquear(b, false);
  $("inClave").value = "";
});

$("btnVer").addEventListener("click", function(){
  var i = $("inClave"), ver = i.type === "password";
  i.type = ver ? "text" : "password";
  $("btnVer").textContent = ver ? "Ocultar" : "Ver";
  i.focus();
});

$("altaClave").addEventListener("input", function(){
  var f = SEG.fuerza($("altaClave").value);
  $("fuerza").className = "fuerza " + ($("altaClave").value ? f.nivel : "");
});

$("formAlta").addEventListener("submit", async function(e){
  e.preventDefault();
  var u = $("altaUsuario").value, c = $("altaClave").value, c2 = $("altaClave2").value;
  if(c !== c2){ say($("msgAlta"), "Las dos contraseñas no coinciden.", "err"); return; }
  var b = $("btnAlta");
  bloquear(b, true, "Guardando…");
  try{
    var r = await SEG.crearPrimero(u, c);
    if(!r.ok){ if(r.error) say($("msgAlta"), r.error, "err"); }
    else { $("altaClave").value = ""; $("altaClave2").value = ""; say($("msgAlta"), ""); }
  }catch(err){
    say($("msgAlta"), "No se pudo guardar: " + err.message, "err");
  }
  bloquear(b, false);
});

function abrirPw(){
  $("pwSub").textContent = SEG.modo === "api"
    ? "Se aplicará en el servidor central y tendrás que iniciar sesión de nuevo."
    : "Se aplicará solo en este equipo.";
  $("pwAct").value = ""; $("pwNue").value = ""; $("pwNue2").value = "";
  say($("msgPw"), "");
  $("ovPw").hidden = false;
  document.body.classList.add("noscroll");
  setTimeout(function(){ $("pwAct").focus(); }, 60);
}
function cerrarPw(){
  $("ovPw").hidden = true;
  if($("ov").hidden) document.body.classList.remove("noscroll");
}
$("btnClave").addEventListener("click", abrirPw);
$("pwX").addEventListener("click", cerrarPw);
$("pwCancel").addEventListener("click", cerrarPw);
$("formPw").addEventListener("submit", async function(e){
  e.preventDefault();
  var a = $("pwAct").value, n = $("pwNue").value, n2 = $("pwNue2").value;
  if(n !== n2){ say($("msgPw"), "Las dos contraseñas nuevas no coinciden.", "err"); return; }
  if(a === n){ say($("msgPw"), "La contraseña nueva debe ser distinta de la actual.", "err"); return; }
  var b = $("pwOk");
  bloquear(b, true, "Guardando…");
  try{
    var r = await SEG.cambiar(a, n);
    if(!r.ok) say($("msgPw"), r.error, "err");
    else{
      say($("msgPw"), r.aviso, "ok");
      setTimeout(function(){
        cerrarPw();
        if(r.salir) SEG.caducada();
      }, 1200);
    }
  }catch(err){
    say($("msgPw"), "No se pudo cambiar la contraseña: " + err.message, "err");
  }
  bloquear(b, false);
});
$("btnSalir").addEventListener("click", function(){ SEG.salir(); });

/* Ir y volver entre “entrar” y “crear el primer administrador”. */
$("btnIrPrimer").addEventListener("click", function(){ SEG.verAlta(""); });
$("btnVolverLogin").addEventListener("click", function(){ SEG.verLogin(""); });

/* ------------------------------------------------------------------ *
 * Panel de usuarios (solo administradores del servidor en la nube)
 * ------------------------------------------------------------------ */
function filaUsuario(u){
  var tr = document.createElement("tr");
  function celda(txt){ var td = document.createElement("td"); td.textContent = txt; tr.appendChild(td); return td; }
  celda(u.usuario);
  celda(u.rol === "admin" ? "Administrador" : "Auditor");
  celda(u.activo ? "Activo" : "Bloqueado");
  celda(u.ultimo ? fechaCorta(u.ultimo) : "Nunca ha entrado");
  var td = document.createElement("td");
  td.className = "acciones";
  var propio = (u.usuario === SEG.usuario);
  var bEstado = document.createElement("button");
  bEstado.type = "button";
  bEstado.className = "ghost mini";
  bEstado.textContent = u.activo ? "Bloquear" : "Reactivar";
  bEstado.disabled = propio;
  if(propio) bEstado.title = "No puedes bloquear tu propia cuenta.";
  bEstado.addEventListener("click", function(){ cambiarEstado(u.usuario, !u.activo); });
  var bClave = document.createElement("button");
  bClave.type = "button";
  bClave.className = "ghost mini";
  bClave.textContent = "Restablecer clave";
  bClave.addEventListener("click", function(){ resetClave(u.usuario); });
  td.appendChild(bEstado);
  td.appendChild(bClave);
  tr.appendChild(td);
  return tr;
}

function fechaCorta(v){
  var d = new Date(v);
  if(isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es", { day:"2-digit", month:"2-digit", year:"numeric" }) +
         " " + d.toLocaleTimeString("es", { hour:"2-digit", minute:"2-digit" });
}

function mensajeTabla(txt){
  var tb = $("usrTb");
  tb.textContent = "";
  var tr = document.createElement("tr");
  var td = document.createElement("td");
  td.colSpan = 5;
  td.className = "vacio";
  td.textContent = txt;
  tr.appendChild(td);
  tb.appendChild(tr);
}

async function listarUsuarios(){
  mensajeTabla("Cargando usuarios…");
  try{
    var r = await SEG.pedir("api/usuarios");
    if(r.status !== 200 || !r.datos || !r.datos.usuarios){
      mensajeTabla("No se pudo obtener la lista de usuarios.");
      return;
    }
    var lista = r.datos.usuarios;
    if(!lista.length){ mensajeTabla("Todavía no hay usuarios."); return; }
    var tb = $("usrTb");
    tb.textContent = "";
    lista.forEach(function(u){ tb.appendChild(filaUsuario(u)); });
  }catch(err){
    mensajeTabla("No se pudo obtener la lista: " + err.message);
  }
}

async function cambiarEstado(u, activo){
  say($("msgUsr"), activo ? "Reactivando…" : "Bloqueando…");
  try{
    var r = await SEG.pedir("api/usuarios/" + encodeURIComponent(u) + "/estado", { activo: !!activo });
    if(r.status === 200 && r.datos && r.datos.ok){
      say($("msgUsr"), activo ? "La cuenta de “" + u + "” vuelve a estar activa."
                              : "La cuenta de “" + u + "” quedó bloqueada.", "ok");
      await listarUsuarios();
    } else {
      say($("msgUsr"), (r.datos && r.datos.error) || "No se pudo cambiar el estado.", "err");
    }
  }catch(err){
    say($("msgUsr"), "No se pudo cambiar el estado: " + err.message, "err");
  }
}

async function resetClave(u){
  var nueva = prompt("Contraseña nueva para “" + u + "” (mínimo 8, con letras y números):", "");
  if(nueva === null) return;
  nueva = String(nueva);
  var f = SEG.fuerza(nueva);
  if(f.nivel === "b"){ say($("msgUsr"), f.aviso, "err"); return; }
  say($("msgUsr"), "Guardando la contraseña…");
  try{
    var r = await SEG.pedir("api/usuarios/" + encodeURIComponent(u) + "/clave", { clave: nueva });
    if(r.status === 200 && r.datos && r.datos.ok){
      say($("msgUsr"), "Listo. Entrégale la contraseña a “" + u + "” por un medio seguro y pídele que la cambie al entrar.", "ok");
    } else {
      say($("msgUsr"), (r.datos && r.datos.error) || "No se pudo restablecer la contraseña.", "err");
    }
  }catch(err){
    say($("msgUsr"), "No se pudo restablecer la contraseña: " + err.message, "err");
  }
}

function abrirUsr(){
  $("nuUsuario").value = ""; $("nuClave").value = ""; $("nuRol").value = "auditor";
  say($("msgUsr"), "");
  $("ovUsr").hidden = false;
  document.body.classList.add("noscroll");
  listarUsuarios();
  setTimeout(function(){ $("nuUsuario").focus(); }, 60);
}
function cerrarUsr(){
  $("ovUsr").hidden = true;
  if($("ov").hidden && $("ovPw").hidden) document.body.classList.remove("noscroll");
}
$("btnUsuarios").addEventListener("click", abrirUsr);
$("usrX").addEventListener("click", cerrarUsr);
$("usrCerrar").addEventListener("click", cerrarUsr);
$("formUsr").addEventListener("submit", async function(e){
  e.preventDefault();
  var u = String($("nuUsuario").value || "").trim().toLowerCase();
  var c = $("nuClave").value;
  if(!/^[a-z0-9._-]{3,32}$/.test(u)){
    say($("msgUsr"), "El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.", "err");
    return;
  }
  var f = SEG.fuerza(c);
  if(f.nivel === "b"){ say($("msgUsr"), f.aviso, "err"); return; }
  var b = $("nuOk");
  bloquear(b, true, "Creando…");
  try{
    var r = await SEG.pedir("api/usuarios", { usuario:u, clave:c, rol:$("nuRol").value });
    if(r.status === 200 && r.datos && r.datos.ok){
      say($("msgUsr"), "Usuario “" + u + "” creado. Entrégale la contraseña por un medio seguro.", "ok");
      $("nuUsuario").value = ""; $("nuClave").value = "";
      await listarUsuarios();
    } else {
      say($("msgUsr"), (r.datos && r.datos.error) || "No se pudo crear el usuario.", "err");
    }
  }catch(err){
    say($("msgUsr"), "No se pudo crear el usuario: " + err.message, "err");
  }
  bloquear(b, false);
});

document.addEventListener("keydown", function(e){
  if(e.key === "Escape" && !$("ovPw").hidden) cerrarPw();
  else if(e.key === "Escape" && !$("ovUsr").hidden) cerrarUsr();
});

/* ------------------------------------------------------------------ *
 * Pestañas y arranque
 * ------------------------------------------------------------------ */
function verPantalla(k){
  $("scrA").classList.toggle("sel", k === "A");
  $("scrB").classList.toggle("sel", k === "B");
  $("tabA").classList.toggle("sel", k === "A");
  $("tabB").classList.toggle("sel", k === "B");
  if(k === "B") cargarTabla();
}
$("tabA").addEventListener("click", function(){ verPantalla("A"); });
$("tabB").addEventListener("click", function(){ verPantalla("B"); });

async function detectar(){
  try{
    var ctrl = new AbortController();
    var to = setTimeout(function(){ ctrl.abort(); }, 2500);
    var r = await fetch("api/health", { signal: ctrl.signal });
    clearTimeout(to);
    if(r.ok){
      var j = await r.json();
      if(j && j.ok){
        MODE = "api"; Store = Api;
        $("dot").className = "dot on";
        var n = j.nube || {};
        var donde = n.permanente
          ? "Nube conectada · tus documentos quedan guardados de forma permanente"
          : "Nube conectada · atención: almacenamiento temporal, pide activar la nube de archivos";
        $("modeTxt").textContent = j.instalar
          ? "Nube conectada · falta crear el administrador"
          : donde;
        configurarDestino();
        return;
      }
    }
  }catch(e){ /* sin servidor: modo local */ }
  MODE = "local"; Store = Local;
  $("dot").className = "dot";
  $("modeTxt").textContent = "";
  $("who").hidden = true;  // ocultar barra de sesión en modo local
  configurarDestino();
}

/* --- Botones del modal Anexar / Reemplazar --- */
$("modalRA-add").addEventListener("click", function(){
  var p = _pendingModal; if(!p) return;
  $("modalRA").hidden = true; document.body.classList.remove("noscroll");
  /* Anexar: agregar los nuevos PDF a la cola, se fusionarán con el existente al procesar */
  if(!pending[p.sigla]) pending[p.sigla] = [];
  p.arr.forEach(function(f){ pending[p.sigla].push(f); });
  _pendingModal = null;
  var n = (pending[p.sigla] || []).length;
  var zone = $("zone-" + p.sigla);
  zone.classList.toggle("has", n > 0);
  zone.textContent = n + " PDF en cola · clic para añadir más";
  var st = $("st-" + p.sigla);
  st.textContent = "Listo: se unirán " + n + " PDF con el documento guardado";
  st.className = "state";
  pintarLista(p.sigla); refrescarObjetivos(); botones();
});

$("modalRA-rep").addEventListener("click", async function(){
  var p = _pendingModal; if(!p) return;
  $("modalRA").hidden = true; document.body.classList.remove("noscroll");
  /* Reemplazar: eliminar el documento guardado y poner solo los nuevos */
  if(activo && activo.docs && activo.docs[p.sigla]){
    try {
      /* Eliminar el archivo guardado del almacenamiento */
      if(MODE === "api"){
        await fetch("api/lotes/" + encodeURIComponent(activo.id) + "/docs/" + encodeURIComponent(p.sigla),
          { method:"DELETE", credentials:"same-origin" });
      } else {
        await IDB.delF([activo.id + "|" + p.sigla]);
      }
      delete activo.docs[p.sigla];
      await IDB.put(activo); /* actualizar metadatos del lote */
    } catch(e){ /* si falla la eliminación, continuar de todas formas */ }
  }
  pending[p.sigla] = p.arr.slice();
  _pendingModal = null;
  var n = pending[p.sigla].length;
  var zone = $("zone-" + p.sigla);
  zone.classList.toggle("has", n > 0);
  zone.textContent = n + " PDF en cola · clic para añadir más";
  var st = $("st-" + p.sigla);
  st.textContent = n === 1 ? "Listo para procesar" : "Listo: se unirán " + n + " PDF en uno solo";
  st.className = "state";
  $("box-" + p.sigla).classList.remove("done");
  pintarLista(p.sigla); refrescarObjetivos(); botones(); pintarActivo();
});

$("modalRA-cancel").addEventListener("click", cerrarModalAR);

$("modalRA").addEventListener("click", function(e){
  if(e.target === this) cerrarModalAR();
});
/* --- Fin botones modal --- */

pintarCajas();
vistaPrevia();
botones();
/* Acceso directo sin pantalla de login en modo local.
   En modo api (servidor) el gate se muestra normalmente. */
$("gate").hidden = true;
detectar()
  .then(function(){ return SEG.iniciar(MODE); })
  .then(cargarTabla);

})();
