/* ============================================================
   NEXUSMED IPS - MOTOR DE DATOS COMPARTIDOS EN LA NUBE
   Guarda y sincroniza los datos del sistema en un almacen
   remoto para que varios usuarios trabajen sobre la MISMA
   informacion. Debe cargarse ANTES de permisos.js.
   ============================================================ */
(function () {
    'use strict';

    var BASE = 'https://textdb.online/';
    var NS = 'nxmed_b7f3a9c2e4d1_';          // espacio de nombres del sistema
    var LIMITE = 195000;                      // caracteres por clave
    var INTERVALO = 20000;                    // revisar cambios de otros usuarios

    /* Claves compartidas por todos los usuarios */
    var COMPARTIDAS = [
        'nexus_usuarios', 'nexus_permisos', 'nexus_hospital',
        'nexus_pacientes', 'nexus_citas', 'nexus_historias_clinicas',
        'nexus_evoluciones', 'nexus_notas_enfermeria', 'nexus_terapias',
        'nexus_epicrisis',
        'nexus_contador_hc', 'nexus_contador_admision', 'nexus_contador_evo',
        'nexus_contador_ne', 'nexus_contador_te', 'nexus_contador_epi',
        'nexus_servicios_facturacion', 'nexus_entidades_pagadoras',
        'nexus_facturas', 'nexus_rips_generados', 'nexus_contador_facturas',
        'nexus_contador_prefacturas', 'nexus_config_ips'
    ];

    /* Claves que NUNCA se comparten (son de cada navegador) */
    var LOCALES = ['nexus_sesion'];

    var esCompartida = function (k) {
        return COMPARTIDAS.indexOf(k) !== -1;
    };

    var espejo = {};        // ultimo contenido conocido del servidor
    var pendientes = {};    // claves con cambios sin enviar
    var eliminadas = {};    // claves que el usuario elimino intencionalmente
    var enviando = false;
    var listo = false;
    var conectado = false;

    /* ================== ACCESO AL ALMACEN REMOTO ================== */

    function leerRemoto(clave) {
        var url = BASE + NS + clave + '?t=' + Date.now();
        return fetch(url, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('lectura ' + r.status);
            return r.text();
        });
    }

    function escribirRemoto(clave, valor) {
        var cuerpo = 'key=' + encodeURIComponent(NS + clave) +
                     '&value=' + encodeURIComponent(valor);
        return fetch(BASE + 'update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: cuerpo
        }).then(function (r) { return r.json(); }).then(function (j) {
            if (!j || j.status !== 1) throw new Error((j && j.error) || 'escritura fallida');
            return true;
        });
    }

    /* ================== UTILIDADES DE DATOS ================== */

    function analizar(texto) {
        if (texto === null || texto === undefined) return null;
        var t = String(texto).trim();
        if (!t) return null;
        try { return JSON.parse(t); } catch (e) { return null; }
    }

    function identificador(item) {
        if (!item || typeof item !== 'object') return JSON.stringify(item);
        if (item.id !== undefined && item.id !== null && item.id !== '') return 'id:' + item.id;
        if (item.usuario !== undefined && item.usuario !== '') return 'us:' + String(item.usuario).toLowerCase();
        if (item.numeroHistoria !== undefined && item.numeroHistoria !== '') return 'hc:' + item.numeroHistoria;
        if (item.numero !== undefined && item.numero !== '') return 'nu:' + item.numero;
        if (item.documento !== undefined && item.documento !== '') return 'do:' + item.documento;
        return 'js:' + JSON.stringify(item);
    }

    /* Union de tres versiones: base (lo que habia en el servidor la ultima vez),
       mio (lo que tiene este navegador) y ajeno (lo que hay ahora en el servidor). */
    function unir(base, mio, ajeno) {
        var a = analizar(mio), b = analizar(ajeno), c = analizar(base);

        if (a === null) return ajeno;
        if (b === null) return mio;

        /* Contadores: se conserva el mayor */
        if (typeof a === 'number' && typeof b === 'number') {
            return JSON.stringify(Math.max(a, b));
        }

        /* Listas de registros: se combinan por identificador */
        if (Array.isArray(a) && Array.isArray(b)) {
            var mapaBase = {};
            if (Array.isArray(c)) c.forEach(function (x) { mapaBase[identificador(x)] = true; });

            var resultado = [];
            var vistos = {};

            a.forEach(function (x) {
                var k = identificador(x);
                if (!vistos[k]) { vistos[k] = true; resultado.push(x); }
            });

            b.forEach(function (x) {
                var k = identificador(x);
                if (vistos[k]) return;             // ya esta en mi version
                if (mapaBase[k]) return;           // yo lo borre a proposito
                vistos[k] = true;
                resultado.push(x);                 // lo agrego otro usuario
            });

            return JSON.stringify(resultado);
        }

        /* Objetos sueltos (datos del hospital, matriz de permisos): gana el ultimo cambio */
        return mio;
    }

    /* ================== SINCRONIZACION ================== */

    function bajarTodo() {
        var tareas = COMPARTIDAS.map(function (clave) {
            return leerRemoto(clave).then(function (texto) {
                var base = espejo[clave] === undefined ? '' : espejo[clave];
                espejo[clave] = texto;
                /* Si hay cambios locales pendientes, hacer MERGE en vez de sobrescribir.
                   Esto preserva eliminaciones locales intencionales (ej: purgar datos)
                   que aún no se han sincronizado con el servidor. */
                var actual = localStorage.getItem(clave);
                var tienePendientes = pendientes[clave];
                if (String(texto).trim()) {
                    if (tienePendientes) {
                        /* Si hay cambios locales pendientes, hacer MERGE en vez de sobrescribir.
                           Esto preserva eliminaciones locales intencionales (ej: purgar datos)
                           que aún no se han sincronizado con el servidor.
                           Si localStorage está vacío o null, significa que el usuario
                           eliminó todo localmente → NO restaurar datos del servidor. */
                        if (actual !== null && String(actual).trim()) {
                            var merge = unir(base, actual, texto);
                            var mergeStr = merge !== null && merge !== undefined ? String(merge) : '';
                            almacenarLocal(clave, mergeStr);
                            espejo[clave] = mergeStr;
                        }
                        /* Si actual es null/vacío con pendientes → eliminación intencional,
                           NO sobrescribir con datos remotos. Se sincronizará en enviarPendientes(). */
                    } else {
                        almacenarLocal(clave, texto);
                    }
                } else {
                    if (actual && String(actual).trim()) pendientes[clave] = true;
                }
                return true;
            }).catch(function () { return false; });
        });

        return Promise.all(tareas).then(function (res) {
            conectado = res.some(function (r) { return r; });
            return conectado;
        });
    }

    function enviarPendientes() {
        var claves = Object.keys(pendientes);
        if (!claves.length || enviando) return Promise.resolve(true);
        enviando = true;

        var cadena = claves.reduce(function (p, clave) {
            return p.then(function () {
                var mio = localStorage.getItem(clave);
                if (mio === null) mio = '';
                var esEliminacion = !!eliminadas[clave];
                /* Si el usuario elimino intencionalmente una clave (localStorage vacio + marca eliminadas),
                   NO hacer merge con el servidor — sobrescribir el servidor con vacio.
                   Esto evita que unir() restaure datos que se borraron a proposito. */
                if (esEliminacion && (!String(mio).trim() || String(mio).trim() === '[]' || String(mio).trim() === 'null')) {
                    return escribirRemoto(clave, '').then(function () {
                        espejo[clave] = '';
                        almacenarLocal(clave, '');
                        delete pendientes[clave];
                        delete eliminadas[clave];
                    });
                }
                return leerRemoto(clave).then(function (ajeno) {
                    var final = unir(espejo[clave], mio, ajeno);
                    if (final === null || final === undefined) final = '';
                    if (String(final).length > LIMITE) {
                        avisar('Los datos de "' + etiqueta(clave) + '" son demasiado grandes para guardarse en la nube.', 'error');
                        delete pendientes[clave];
                        delete eliminadas[clave];
                        return;
                    }
                    return escribirRemoto(clave, String(final)).then(function () {
                        espejo[clave] = String(final);
                        almacenarLocal(clave, String(final));
                        delete pendientes[clave];
                        delete eliminadas[clave];
                    });
                });
            }).catch(function () { /* se reintenta en el siguiente ciclo */ });
        }, Promise.resolve());

        return cadena.then(function () { enviando = false; return true; });
    }

    function revisarCambios() {
        if (enviando || Object.keys(pendientes).length) return;
        var cambio = false;
        var tareas = COMPARTIDAS.map(function (clave) {
            return leerRemoto(clave).then(function (texto) {
                if (String(texto) !== String(espejo[clave] === undefined ? '' : espejo[clave])) {
                    var mio = localStorage.getItem(clave);
                    if (mio === null) mio = '';
                    /* PROTECCION CONTRA RESTAURACION DE DATOS ELIMINADOS:
                       Si el usuario elimino intencionalmente una clave (marcada en eliminadas)
                       y localStorage esta vacio/[] para esa clave, NO restaurar datos del servidor.
                       Esperar a que enviarPendientes() sincronice la eliminacion con la nube. */
                    if (eliminadas[clave] && (!String(mio).trim() || String(mio).trim() === '[]' || String(mio).trim() === 'null')) {
                        /* Eliminacion intencional pendiente de sincronizar — NO restaurar */
                        return;
                    }
                    /* Guardar base (lo que creiamos que tenia el servidor) ANTES de actualizar espejo */
                    var base = espejo[clave] === undefined ? '' : espejo[clave];
                    /* Usar merge (unir) en lugar de sobrescritura directa para
                       respetar eliminaciones locales y cambios de otros usuarios */
                    var merge = unir(base, mio, texto);
                    var mergeStr = merge !== null && merge !== undefined ? String(merge) : '';
                    almacenarLocal(clave, mergeStr);
                    /* Actualizar espejo al resultado fusionado (no al dato remoto crudo)
                       para que la proxima comparacion detecte solo cambios REALES */
                    espejo[clave] = mergeStr;
                    if (clave !== 'nexus_sesion') cambio = true;
                }
            }).catch(function () { });
        });
        Promise.all(tareas).then(function () {
            if (cambio) mostrarAvisoRecarga();
        });
    }

    /* ================== PUENTE CON localStorage ================== */

    var _set = localStorage.setItem.bind(localStorage);
    var _remove = localStorage.removeItem.bind(localStorage);
    var _clear = localStorage.clear.bind(localStorage);

    function almacenarLocal(clave, valor) {
        try { _set(clave, valor); } catch (e) { }
    }

    localStorage.setItem = function (clave, valor) {
        _set(clave, valor);
        if (esCompartida(clave)) {
            pendientes[clave] = true;
            /* Detectar cuando el usuario guarda [] o null — es una eliminacion intencional (purga) */
            var v = String(valor || '').trim();
            if (!v || v === '[]' || v === 'null') {
                eliminadas[clave] = true;
                espejo[clave] = '';
            }
            programarEnvio();
        }
    };

    localStorage.removeItem = function (clave) {
        _remove(clave);
        if (esCompartida(clave)) {
            pendientes[clave] = true;
            eliminadas[clave] = true;  // marca: eliminacion intencional
            espejo[clave] = '';        // borrado intencional: se vacia en la nube
            programarEnvio();
        }
    };

    localStorage.clear = function () {
        var sesion = localStorage.getItem('nexus_sesion');
        _clear();
        if (sesion) _set('nexus_sesion', sesion);
        COMPARTIDAS.forEach(function (c) { pendientes[c] = true; eliminadas[c] = true; espejo[c] = ''; });
        programarEnvio();
    };

    var temporizador = null;
    function programarEnvio() {
        if (temporizador) clearTimeout(temporizador);
        temporizador = setTimeout(function () {
            temporizador = null;
            enviarPendientes();
        }, 700);
    }

    /* Antes de cerrar la pagina se intenta guardar lo que quede pendiente */
    window.addEventListener('beforeunload', function () {
        var claves = Object.keys(pendientes);
        if (!claves.length || !navigator.sendBeacon) return;
        claves.forEach(function (clave) {
            var mio = localStorage.getItem(clave);
            if (mio === null) mio = '';
            var datos = new URLSearchParams();
            datos.set('key', NS + clave);
            datos.set('value', String(mio));
            try { navigator.sendBeacon(BASE + 'update', datos); } catch (e) { }
        });
    });

    /* ================== ARRANQUE CONTROLADO ================== */

    var enEspera = [];
    var _addDoc = document.addEventListener.bind(document);

    document.addEventListener = function (tipo, fn, op) {
        if (tipo === 'DOMContentLoaded' && !listo && typeof fn === 'function') {
            enEspera.push(fn);
            return;
        }
        return _addDoc(tipo, fn, op);
    };

    function domPreparado() {
        return document.readyState === 'interactive' || document.readyState === 'complete';
    }

    function liberarArranque() {
        listo = true;
        var correr = function () {
            enEspera.forEach(function (fn) {
                try { fn(); } catch (e) { console.error(e); } // eslint-disable-line
            });
            enEspera = [];
            quitarCortina();
        };
        if (domPreparado()) correr(); else _addDoc('DOMContentLoaded', correr);
    }

    /* ================== AVISOS EN PANTALLA ================== */

    function estilos() {
        if (document.getElementById('nxdb-css')) return;
        var s = document.createElement('style');
        s.id = 'nxdb-css';
        s.textContent =
            '#nxdb-cortina{position:fixed;inset:0;z-index:99999;background:#0a1628;display:flex;align-items:center;' +
            'justify-content:center;flex-direction:column;gap:16px;font-family:Inter,system-ui,sans-serif;color:#90e0ef}' +
            '#nxdb-cortina .aro{width:46px;height:46px;border:3px solid #1a3a5c;border-top-color:#00b4d8;' +
            'border-radius:50%;animation:nxdbGiro .9s linear infinite}' +
            '@keyframes nxdbGiro{to{transform:rotate(360deg)}}' +
            '#nxdb-cortina p{margin:0;font-size:14px;color:#5a7a9a}' +
            '.nxdb-aviso{position:fixed;right:18px;bottom:18px;z-index:99998;max-width:330px;background:#0d2137;' +
            'border:1px solid #1a3a5c;border-left:4px solid #00b4d8;border-radius:10px;padding:14px 16px;' +
            'font-family:Inter,system-ui,sans-serif;color:#90e0ef;font-size:13px;line-height:1.5;' +
            'box-shadow:0 10px 30px rgba(0,0,0,.45)}' +
            '.nxdb-aviso.error{border-left-color:#ef476f}' +
            '.nxdb-aviso button{margin-top:10px;background:#00b4d8;color:#06263a;border:0;border-radius:7px;' +
            'padding:7px 13px;font-weight:600;cursor:pointer;font-family:inherit;font-size:12px}' +
            '.nxdb-aviso .cerrar{position:absolute;top:8px;right:10px;background:none;color:#5a7a9a;' +
            'font-size:15px;padding:0;margin:0;cursor:pointer}';
        (document.head || document.documentElement).appendChild(s);
    }

    function ponerCortina() {
        estilos();
        if (document.getElementById('nxdb-cortina')) return;
        var d = document.createElement('div');
        d.id = 'nxdb-cortina';
        d.innerHTML = '<div class="aro"></div><p>Conectando con los datos del hospital...</p>';
        var meter = function () {
            if (document.body && !document.getElementById('nxdb-cortina')) document.body.appendChild(d);
            else if (!document.body) setTimeout(meter, 30);
        };
        meter();
    }

    function quitarCortina() {
        var d = document.getElementById('nxdb-cortina');
        if (d && d.parentNode) d.parentNode.removeChild(d);
    }

    function avisar(texto, tipo) {
        estilos();
        var poner = function () {
            if (!document.body) { setTimeout(poner, 40); return; }
            var c = document.createElement('div');
            c.className = 'nxdb-aviso' + (tipo === 'error' ? ' error' : '');
            c.style.position = 'fixed';
            var b = document.createElement('button');
            b.className = 'cerrar';
            b.textContent = '\u00d7';
            b.onclick = function () { if (c.parentNode) c.parentNode.removeChild(c); };
            var p = document.createElement('div');
            p.textContent = texto;
            c.appendChild(b);
            c.appendChild(p);
            document.body.appendChild(c);
            setTimeout(function () { if (c.parentNode) c.parentNode.removeChild(c); }, 9000);
        };
        poner();
    }

    var avisoAbierto = false;
    function mostrarAvisoRecarga() {
        if (avisoAbierto || !document.body) return;
        avisoAbierto = true;
        estilos();
        var c = document.createElement('div');
        c.className = 'nxdb-aviso';
        var p = document.createElement('div');
        p.textContent = 'Otro usuario acaba de guardar informacion nueva.';
        var b = document.createElement('button');
        b.textContent = 'Actualizar pantalla';
        b.onclick = function () { location.reload(); };
        var x = document.createElement('button');
        x.className = 'cerrar';
        x.textContent = '\u00d7';
        x.onclick = function () {
            if (c.parentNode) c.parentNode.removeChild(c);
            avisoAbierto = false;
        };
        c.appendChild(x); c.appendChild(p); c.appendChild(b);
        document.body.appendChild(c);
    }

    function etiqueta(clave) {
        var n = {
            nexus_usuarios: 'Usuarios', nexus_permisos: 'Permisos', nexus_hospital: 'Datos del hospital',
            nexus_pacientes: 'Pacientes', nexus_citas: 'Citas', nexus_historias_clinicas: 'Historias clinicas',
            nexus_evoluciones: 'Evoluciones', nexus_notas_enfermeria: 'Notas de enfermeria',
            nexus_terapias: 'Terapias', nexus_epicrisis: 'Epicrisis',
            nexus_servicios_facturacion: 'Catálogo servicios', nexus_entidades_pagadoras: 'Entidades pagadoras',
            nexus_facturas: 'Facturas', nexus_rips_generados: 'RIPS generados',
            nexus_contador_facturas: 'Contador facturas'
        };
        return n[clave] || clave;
    }

    /* ================== CONTRASENAS (resumen seguro) ================== */

    var sha256 = (function () {
        var K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

        function rr(x, n) { return (x >>> n) | (x << (32 - n)); }

        return function (mensaje) {
            var utf8 = unescape(encodeURIComponent(mensaje));
            var largo = utf8.length;
            var bytes = [];
            for (var i = 0; i < largo; i++) bytes.push(utf8.charCodeAt(i) & 0xff);
            bytes.push(0x80);
            while (bytes.length % 64 !== 56) bytes.push(0);
            var bits = largo * 8;
            bytes.push(0, 0, 0, 0);
            bytes.push((bits >>> 24) & 0xff, (bits >>> 16) & 0xff, (bits >>> 8) & 0xff, bits & 0xff);

            var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                     0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
            var w = new Array(64);

            for (var bloque = 0; bloque < bytes.length; bloque += 64) {
                for (var t = 0; t < 16; t++) {
                    w[t] = (bytes[bloque + t * 4] << 24) | (bytes[bloque + t * 4 + 1] << 16) |
                           (bytes[bloque + t * 4 + 2] << 8) | bytes[bloque + t * 4 + 3];
                }
                for (t = 16; t < 64; t++) {
                    var s0 = rr(w[t - 15], 7) ^ rr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
                    var s1 = rr(w[t - 2], 17) ^ rr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
                    w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
                }
                var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
                for (t = 0; t < 64; t++) {
                    var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
                    var ch = (e & f) ^ (~e & g);
                    var t1 = (hh + S1 + ch + K[t] + w[t]) | 0;
                    var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
                    var mj = (a & b) ^ (a & c) ^ (b & c);
                    var t2 = (S0 + mj) | 0;
                    hh = g; g = f; f = e; e = (d + t1) | 0;
                    d = c; c = b; b = a; a = (t1 + t2) | 0;
                }
                h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
                h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
            }
            return h.map(function (x) {
                return ('00000000' + (x >>> 0).toString(16)).slice(-8);
            }).join('');
        };
    })();

    function resumen(usuario, clave) {
        return sha256('nexusmed:' + String(usuario).toLowerCase().trim() + ':' + String(clave));
    }

    function usuarios() {
        var l = analizar(localStorage.getItem('nexus_usuarios'));
        return Array.isArray(l) ? l : [];
    }

    function guardarUsuarios(lista) {
        localStorage.setItem('nexus_usuarios', JSON.stringify(lista));
    }

    var NXAUTH = {
        resumen: resumen,
        usuarios: usuarios,
        guardarUsuarios: guardarUsuarios,

        /* Todavia no hay ningun usuario creado en la nube */
        sinUsuarios: function () { return usuarios().length === 0; },

        /* Comprueba credenciales contra la base compartida */
        verificar: function (usuario, clave) {
            var lista = usuarios();
            var u = lista.filter(function (x) {
                return String(x.usuario).toLowerCase().trim() === String(usuario).toLowerCase().trim();
            })[0];
            if (!u) return null;
            var esperado = u.clave || u.hash || '';
            if (esperado && esperado === resumen(u.usuario, clave)) return u;
            /* Compatibilidad con datos antiguos guardados en texto plano */
            if (!esperado && (u.password === clave || u.contrasena === clave)) {
                u.clave = resumen(u.usuario, clave);
                delete u.password; delete u.contrasena;
                guardarUsuarios(lista);
                return u;
            }
            return null;
        },

        cambiarClave: function (usuario, actual, nueva) {
            var lista = usuarios();
            var i = -1;
            lista.forEach(function (x, n) {
                if (String(x.usuario).toLowerCase().trim() === String(usuario).toLowerCase().trim()) i = n;
            });
            if (i === -1) return 'inexistente';
            if (!NXAUTH.verificar(usuario, actual)) return 'clave';
            lista = usuarios();
            lista[i].clave = resumen(lista[i].usuario, nueva);
            delete lista[i].password;
            delete lista[i].contrasena;
            lista[i].fechaCambioClave = new Date().toISOString();
            guardarUsuarios(lista);
            return 'ok';
        },

        crearAdministrador: function (usuario, nombre, clave) {
            if (usuarios().length) return false;
            guardarUsuarios([{
                usuario: String(usuario).toLowerCase().trim(),
                nombre: nombre,
                documento: '',
                clave: resumen(usuario, clave),
                rol: 'admin',
                especialidad: 'Administracion',
                registro: '',
                firma: '',
                fechaRegistro: new Date().toISOString()
            }]);
            return true;
        },

        /* Espera a que termine el envio de datos a la nube */
        guardado: function () { return enviarPendientes(); }
    };

    /* ================== ROLES Y PROFESIONALES ================== */

    var NOMBRE_ROL = {
        admin: 'Administrador',
        recepcion: 'Recepcionista',
        medico_general: 'Medico General',
        enfermeria: 'Enfermeria',
        terapia: 'Terapia',
        especialista: 'Especialista'
    };

    /* Convierte cualquier forma de escribir el rol al identificador oficial */
    function normalizarRol(rol) {
        var r = String(rol === undefined || rol === null ? '' : rol)
            .toLowerCase().trim().replace(/\s+/g, '_');
        if (!r) return '';
        if (NOMBRE_ROL[r]) return r;
        if (r.indexOf('admin') !== -1 || r.indexOf('gerente') !== -1) return 'admin';
        if (r.indexOf('recep') !== -1 || r.indexOf('secretar') !== -1 || r.indexOf('facturac') !== -1) return 'recepcion';
        if (r.indexOf('especialista') !== -1 || r.indexOf('especialidad') !== -1) return 'especialista';
        if (r.indexOf('medic') !== -1 || r.indexOf('m\u00e9dic') !== -1 || r.indexOf('doctor') !== -1 ||
            r.indexOf('cirujan') !== -1 || r.indexOf('odontolog') !== -1 || r.indexOf('odont\u00f3log') !== -1) return 'medico_general';
        if (r.indexOf('enferm') !== -1 || r.indexOf('auxiliar') !== -1 || r.indexOf('jefe') !== -1) return 'enfermeria';
        if (r.indexOf('terap') !== -1 || r.indexOf('fisio') !== -1 || r.indexOf('kinesiolog') !== -1 ||
            r.indexOf('fonoaudiolog') !== -1 || r.indexOf('ocupacional') !== -1 || r.indexOf('lenguaje') !== -1 ||
            r.indexOf('psicolog') !== -1 || r.indexOf('psic\u00f3log') !== -1 || r.indexOf('nutricion') !== -1) return 'terapia';
        return '';
    }

    function nombreRol(rol) {
        var r = normalizarRol(rol);
        return NOMBRE_ROL[r] || String(rol === undefined || rol === null ? '' : rol);
    }

    /* Un administrador aparece en las listas clinicas solo si tiene
       registro profesional o una especialidad medica declarada */
    function adminEsProfesional(u) {
        var reg = String(u.registro || '').trim();
        var esp = String(u.especialidad || '').trim().toLowerCase();
        if (reg) return true;
        if (!esp) return false;
        return esp.indexOf('administrac') === -1 && esp.indexOf('sistemas') === -1 && esp !== 'n/a';
    }

    function ordenarPorNombre(lista) {
        return lista.slice().sort(function (a, b) {
            return String(a.nombre || a.usuario || '').localeCompare(String(b.nombre || b.usuario || ''), 'es');
        });
    }

    /* Devuelve los usuarios cuyos roles estan en la lista pedida */
    function profesionales(roles) {
        return ordenarPorNombre(usuarios().filter(function (u) {
            var r = normalizarRol(u.rol);
            if (!r) return false;
            if (r === 'admin') return adminEsProfesional(u) && roles.indexOf('admin_clinico') !== -1;
            return roles.indexOf(r) !== -1;
        }));
    }

    var NXROLES = {
        normalizar: normalizarRol,
        nombre: nombreRol,
        todos: function () { return ordenarPorNombre(usuarios()); },
        medicos: function () { return profesionales(['medico_general', 'especialista', 'admin_clinico']); },
        enfermeria: function () { return profesionales(['enfermeria', 'admin_clinico']); },
        terapia: function () { return profesionales(['terapia', 'admin_clinico']); },
        clinicos: function () {
            return profesionales(['medico_general', 'especialista', 'enfermeria', 'terapia', 'admin_clinico']);
        },
        /* Texto visible del profesional: nombre + especialidad */
        etiquetaPersona: function (u) {
            var n = String(u.nombre || u.usuario || '').trim();
            var e = String(u.especialidad || '').trim();
            return e ? n + ' \u2014 ' + e : n;
        }
    };

    /* ================== API PUBLICA ================== */

    window.NXROLES = NXROLES;
    window.NXDB = {
        claves: COMPARTIDAS,
        locales: LOCALES,
        conectado: function () { return conectado; },
        sincronizar: function () { return enviarPendientes().then(bajarTodo); },
        guardar: function () { return enviarPendientes(); },
        avisar: avisar,
        /* Purgar datos de una clave en el SERVIDOR (no solo local).
           Sobrescribe el servidor con [] para que los datos eliminados no reaparezcan.
           Uso: NXDB.purgarRemoto('nexus_facturas') */
        purgarRemoto: function (clave) {
            if (!esCompartida(clave)) return Promise.resolve(false);
            return escribirRemoto(clave, '[]').then(function () {
                espejo[clave] = '[]';
                delete eliminadas[clave];
                delete pendientes[clave];
                return true;
            }).catch(function () { return false; });
        },
        /* Purgar multiples claves del servidor */
        purgarRemotoTodo: function (claves) {
            var lista = (claves || COMPARTIDAS).filter(esCompartida);
            return Promise.all(lista.map(function (c) {
                return escribirRemoto(c, '[]').then(function () {
                    espejo[c] = '[]';
                    delete eliminadas[c];
                    delete pendientes[c];
                    return true;
                }).catch(function () { return false; });
            }));
        }
    };
    window.NXAUTH = NXAUTH;

    /* ================== INICIO ================== */

    ponerCortina();

    bajarTodo().then(function (ok) {
        if (!ok) {
            avisar('No se pudo conectar con la nube. Se trabajara con la copia guardada en este equipo.', 'error');
        }
        return enviarPendientes();
    }).catch(function () { }).then(function () {
        liberarArranque();
        setInterval(revisarCambios, INTERVALO);
    });

})();
