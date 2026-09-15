/* ============================================================
   NEXUSMED IPS - MOTOR DE DATOS COMPARTIDOS EN LA NUBE
   Guarda y sincroniza los datos del sistema en un almacen
   remoto para que varios usuarios trabajen sobre la MISMA
   informacion. Debe cargarse ANTES de permisos.js.

   v2.2 — Correccion critica: MERGE siempre, nunca sobrescribir
           Perdida de facturas/RIPS al navegar entre modulos
           + Persistencia de pendientes en sessionStorage
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

    /* Restaurar pendientes de sessionStorage para que sobrevivan
       la navegacion entre paginas dentro de la misma pestana.
       Sin esto, al cargar una nueva pagina pendientes={} y
       bajarTodo() sobrescribe datos locales con datos remotos. */
    try {
        var savedPending = sessionStorage.getItem('NXDB_pending');
        if (savedPending) {
            var parsed = JSON.parse(savedPending);
            if (parsed && typeof parsed === 'object') {
                pendientes = parsed;
                console.log('[NXDB] Pendientes restaurados de sessionStorage:', Object.keys(pendientes));
            }
        }
    } catch(e) {}

    /* Guardar pendientes en sessionStorage cada vez que cambien */
    var _pendientesTimer = null;
    function persistirPendientes() {
        if (_pendientesTimer) clearTimeout(_pendientesTimer);
        _pendientesTimer = setTimeout(function () {
            try {
                sessionStorage.setItem('NXDB_pending', JSON.stringify(pendientes));
            } catch(e) {}
        }, 100);
    }

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

    /* Determina si un valor representa "datos vacios" (null, [], {}, 0, objeto con ultimo=0) */
    function esVacio(valor) {
        if (valor === null || valor === undefined) return true;
        if (typeof valor === 'string') {
            var t = valor.trim();
            if (!t || t === '[]' || t === 'null' || t === '{}') return true;
            /* Contadores con {"ultimo":0} tambien son vacios para nuestro proposito */
            try {
                var obj = JSON.parse(t);
                if (typeof obj === 'object' && obj !== null && !Array.isArray(obj) &&
                    Object.keys(obj).length === 1 && obj.ultimo === 0) return true;
            } catch(e) {}
            return false;
        }
        if (Array.isArray(valor)) return valor.length === 0;
        if (typeof valor === 'object' && valor !== null) {
            if (Object.keys(valor).length === 1 && valor.ultimo === 0) return true;
            return Object.keys(valor).length === 0;
        }
        if (typeof valor === 'number') return valor === 0;
        return false;
    }

    /* Determina si un string JSON representa datos con contenido real */
    function tieneContenido(str) {
        var d = analizar(str);
        if (d === null) return false;
        if (Array.isArray(d)) return d.length > 0;
        if (typeof d === 'object' && d !== null) {
            /* Contadores: {"ultimo": N} con N > 0 cuentan como contenido */
            if (Object.keys(d).length === 1 && typeof d.ultimo === 'number') return d.ultimo > 0;
            return Object.keys(d).length > 0;
        }
        if (typeof d === 'number') return d > 0;
        return !!d;
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

        /* Objetos tipo contador {ultimo: N}: conservar el mayor */
        if (typeof a === 'object' && a !== null && !Array.isArray(a) &&
            typeof b === 'object' && b !== null && !Array.isArray(b) &&
            'ultimo' in a && 'ultimo' in b) {
            return JSON.stringify({ ultimo: Math.max(a.ultimo || 0, b.ultimo || 0) });
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
                /* FIX v2.4: Solo considerar como "borrado a proposito" si el local
                   tiene datos (a.length > 0). Si local es un array vacio [],
                   significa "no tengo datos" (primera carga, recarga sin pendientes),
                   NO "borre todo a proposito". Sin este fix, unir() elimina registros
                   del servidor cuando el navegador no tiene datos locales, causando
                   perdida de facturas y RIPS. */
                if (mapaBase[k] && a.length > 0) return;  // yo lo borre a proposito
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
                var actual = localStorage.getItem(clave);
                var tienePendientes = pendientes[clave];

                if (String(texto).trim()) {
                    if (tienePendientes) {
                        /* Cambios locales pendientes → MERGE en vez de sobrescribir */
                        if (actual !== null && String(actual).trim()) {
                            /* PROTECCION CRITICA: Si el remoto es vacio pero el local tiene datos,
                               NO sobrescribir con vacio — esto previene perdida de datos cuando
                               el servidor no recibio los datos aun */
                            if (esVacio(analizar(texto)) && tieneContenido(actual)) {
                                console.log('[NXDB] Proteccion: NO sobrescribir ' + clave + ' local con datos remotos vacios');
                            } else {
                                var merge = unir(base, actual, texto);
                                var mergeStr = merge !== null && merge !== undefined ? String(merge) : '';
                                almacenarLocal(clave, mergeStr);
                                espejo[clave] = mergeStr;
                            }
                        }
                        /* Si actual es null/vacio con pendientes → eliminacion intencional,
                           NO sobrescribir con datos remotos. Se sincronizara en enviarPendientes(). */
                    } else {
                        /* PROTECCION CRITICA v2: Si el remoto tiene "[]" (vacio) pero el local
                           tiene datos reales (array con elementos), NO sobrescribir.
                           Esto previene que bajarTodo() elimine datos locales cuando el servidor
                           no tiene los datos actualizados. En su lugar, marca como pendiente
                           para que el dato local se suba al servidor. */
                        if (esVacio(analizar(texto)) && tieneContenido(actual)) {
                            console.log('[NXDB] Proteccion: ' + clave + ' local tiene datos, NO sobrescribir con remoto vacio — marcando pendiente');
                            pendientes[clave] = true;
                            persistirPendientes();
                        } else if (tieneContenido(actual)) {
                            /* CORRECCION CRITICA v2.2: SIEMPRE hacer MERGE cuando el local
                               tiene datos, NUNCA sobrescribir directamente.
                               Antes: almacenarLocal(clave, texto) → SOBRESCRIBIA datos locales
                               con datos remotos (posiblemente viejos/fantasmas), perdiendo
                               facturas y RIPS guardados en la pagina anterior.
                               Ahora: unir(base, actual, texto) combina ambos, nunca pierde datos.
                               El merge agrega registros remotos que no existen localmente,
                               pero conserva todos los registros locales. */
                            var merge = unir(base, actual, texto);
                            var mergeStr = merge !== null && merge !== undefined ? String(merge) : '';
                            almacenarLocal(clave, mergeStr);
                            espejo[clave] = mergeStr;
                            /* Si el merge agrego datos remotos, hay que subir la combinacion */
                            if (String(mergeStr) !== String(actual)) {
                                pendientes[clave] = true;
                                persistirPendientes();
                            }
                        } else {
                            /* Local vacio → aceptar datos remotos normalmente */
                            almacenarLocal(clave, texto);
                        }
                    }
                } else {
                    /* El servidor no tiene datos para esta clave */
                    if (actual && String(actual).trim()) { pendientes[clave] = true; persistirPendientes(); }
                }
                return true;
            }).catch(function () { return false; });
        });

        return Promise.all(tareas).then(function (res) {
            conectado = res.some(function (r) { return r; });

            /* ── RESTAURAR BACKUP si se perdieron datos criticos ── */
            ['nexus_facturas', 'nexus_rips_generados'].forEach(function(clave) {
                var actual = localStorage.getItem(clave);
                var backup = localStorage.getItem(clave + '_backup');
                if ((!tieneContenido(actual) || esVacio(analizar(actual))) && tieneContenido(backup)) {
                    console.warn('[NXDB] Restaurando ' + clave + ' desde backup — datos se perdieron en bajarTodo!');
                    almacenarLocal(clave, backup);
                    pendientes[clave] = true;
                    persistirPendientes();
                }
                /* Limpiar backup viejo (>24h) */
                if (tieneContenido(backup)) {
                    try {
                        var bData = JSON.parse(backup);
                        var bTime = bData._backupTime;
                        if (bTime && Date.now() - bTime > 86400000) {
                            _remove(clave + '_backup');
                        }
                    } catch(e) {}
                }
            });

            /* ── FORZAR SUBIDA: si local tiene datos y servidor no, subir ── */
            setTimeout(function() {
                ['nexus_facturas', 'nexus_rips_generados', 'nexus_contador_facturas'].forEach(function(clave) {
                    var local = localStorage.getItem(clave);
                    if (tieneContenido(local) && pendientes[clave]) {
                        console.log('[NXDB] Forzando subida de ' + clave + ' despues de bajarTodo');
                    }
                });
                if (Object.keys(pendientes).length > 0) {
                    enviarPendientes();
                }
            }, 1500);

            return conectado;
        });
    }

    function enviarPendientes() {
        var claves = Object.keys(pendientes);
        if (!claves.length || enviando) return Promise.resolve(true);
        enviando = true;

        var fallidas = [];  // claves que fallaron al escribir

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
                        persistirPendientes();
                    }).catch(function(err) {
                        console.error('[NXDB] Error escribiendo eliminacion para ' + clave + ':', err);
                        fallidas.push(clave);
                    });
                }
                return leerRemoto(clave).then(function (ajeno) {
                    var final = unir(espejo[clave], mio, ajeno);
                    if (final === null || final === undefined) final = '';
                    if (String(final).length > LIMITE) {
                        avisar('Los datos de "' + etiqueta(clave) + '" son demasiado grandes para guardarse en la nube.', 'error');
                        delete pendientes[clave];
                        delete eliminadas[clave];
                        persistirPendientes();
                        return;
                    }
                    return escribirRemoto(clave, String(final)).then(function () {
                        /* FIX v2.6: ANTES de sobrescribir localStorage con el merge,
                           volver a leer el valor ACTUAL de localStorage. Si el usuario
                           guardó datos MIENTRAS se hacía el upload, esos datos se
                           perderían si simplemente sobrescribimos con `final`.
                           Solución: hacer merge entre `final` y el localStorage actual. */
                        var actualAhora = localStorage.getItem(clave);
                        if (actualAhora !== null && String(actualAhora).trim() && tieneContenido(actualAhora)) {
                            var reMerge = unir(String(final), actualAhora, String(final));
                            if (reMerge !== null && reMerge !== undefined && tieneContenido(String(reMerge))) {
                                final = reMerge;
                            }
                        }
                        espejo[clave] = String(final);
                        almacenarLocal(clave, String(final));
                        delete pendientes[clave];
                        delete eliminadas[clave];
                        persistirPendientes();
                        console.log('[NXDB] ✓ ' + clave + ' subido OK al servidor');
                    }).catch(function(err) {
                        console.error('[NXDB] ✗ Error escribiendo ' + clave + ':', err);
                        fallidas.push(clave);
                    });
                }).catch(function(err) {
                    console.error('[NXDB] Error leyendo remoto para ' + clave + ':', err);
                    fallidas.push(clave);
                });
            });
        }, Promise.resolve());

        return cadena.then(function () {
            enviando = false;
            if (fallidas.length > 0) {
                console.warn('[NXDB] ' + fallidas.length + ' clave(s) fallaron al enviar:', fallidas);
                /* Re-marcar claves fallidas como pendientes para reintentar en el proximo ciclo */
                fallidas.forEach(function(c) {
                    pendientes[c] = true;
                });
                persistirPendientes();
            }
            /* FIX RACE CONDITION: si se agregaron nuevas claves pendientes durante el envio
               (ej: guardar contador → NXDB.guardado() → enviarPendientes → luego guardar factura
               → NXDB.guardado() saltado porque enviando=true), programar un reenvio inmediato */
            var nuevasPendientes = Object.keys(pendientes).filter(function(c) {
                return !fallidas.includes(c);
            });
            if (nuevasPendientes.length > 0) {
                console.log('[NXDB] Nuevas claves pendientes detectadas post-envio, programando reenvio:', nuevasPendientes);
                programarEnvio();
            }
            return true;
        });
    }

    function revisarCambios() {
        if (enviando || Object.keys(pendientes).length) return;
        var cambio = false;
        var tareas = COMPARTIDAS.map(function (clave) {
            return leerRemoto(clave).then(function (texto) {
                if (String(texto) !== String(espejo[clave] === undefined ? '' : espejo[clave])) {
                    var mio = localStorage.getItem(clave);
                    if (mio === null) mio = '';

                    /* PROTECCION CONTRA RESTAURACION DE DATOS ELIMINADOS */
                    if (eliminadas[clave] && (!String(mio).trim() || String(mio).trim() === '[]' || String(mio).trim() === 'null')) {
                        return;
                    }

                    /* PROTECCION CONTRA SOBRESCRITURA CON DATOS VACIOS */
                    if (esVacio(analizar(texto)) && tieneContenido(mio)) {
                        console.log('[NXDB] Proteccion: NO restaurar ' + clave + ' desde servidor vacio');
                        espejo[clave] = String(mio);
                        pendientes[clave] = true;
                        persistirPendientes();
                        return;
                    }

                    var base = espejo[clave] === undefined ? '' : espejo[clave];
                    var merge = unir(base, mio, texto);
                    var mergeStr = merge !== null && merge !== undefined ? String(merge) : '';
                    almacenarLocal(clave, mergeStr);
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

    var _getItem = localStorage.getItem.bind(localStorage);
    var _set = localStorage.setItem.bind(localStorage);
    var _remove = localStorage.removeItem.bind(localStorage);
    var _clear = localStorage.clear.bind(localStorage);

    function almacenarLocal(clave, valor) {
        try { _set(clave, valor); } catch (e) { console.error("[NXDB] localStorage write failed for " + clave + ":", e); avisar("No se pudo guardar localmente: " + etiqueta(clave), "error"); }
    }

    localStorage.setItem = function (clave, valor) {
        try { _set(clave, valor); } catch (e) {
            console.error("[NXDB] localStorage.setItem FAILED for " + clave + ":", e);
            avisar("Error al guardar " + etiqueta(clave) + ": " + (e.message||'quota'), "error");
            return;
        }
        if (esCompartida(clave)) {
            pendientes[clave] = true;
            var v = String(valor || '').trim();
            if (!v || v === '[]' || v === 'null') {
                eliminadas[clave] = true;
                espejo[clave] = '';
            } else {
                /* Si guardamos datos reales, QUITAR marca de eliminada si existia */
                delete eliminadas[clave];
            }
            persistirPendientes();
            programarEnvio();
        }
    };

    localStorage.removeItem = function (clave) {
        _remove(clave);
        if (esCompartida(clave)) {
            pendientes[clave] = true;
            eliminadas[clave] = true;  // marca: eliminacion intencional
            espejo[clave] = '';        // borrado intencional: se vacia en la nube
            persistirPendientes();
            programarEnvio();
        }
    };

    localStorage.clear = function () {
        var sesion = localStorage.getItem('nexus_sesion');
        _clear();
        if (sesion) _set('nexus_sesion', sesion);
        COMPARTIDAS.forEach(function (c) { pendientes[c] = true; eliminadas[c] = true; espejo[c] = ''; });
        persistirPendientes();
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
                try { fn(); } catch (e) { console.error(e); }
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
            nexus_servicios_facturacion: 'Catalogo servicios', nexus_entidades_pagadoras: 'Entidades pagadoras',
            nexus_facturas: 'Facturas', nexus_rips_generados: 'RIPS generados',
            nexus_contador_facturas: 'Contador facturas', nexus_contador_prefacturas: 'Contador pre-facturas',
            nexus_config_ips: 'Configuracion IPS'
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

        sinUsuarios: function () { return usuarios().length === 0; },

        verificar: function (usuario, clave) {
            var lista = usuarios();
            var u = lista.filter(function (x) {
                return String(x.usuario).toLowerCase().trim() === String(usuario).toLowerCase().trim();
            })[0];
            if (!u) return null;
            var esperado = u.clave || u.hash || '';
            if (esperado && esperado === resumen(u.usuario, clave)) return u;
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
        _marcarPendiente: function (clave) {
            if (esCompartida(clave)) {
                pendientes[clave] = true;
                delete eliminadas[clave];
                persistirPendientes();
                programarEnvio();
            }
        },
        avisar: avisar,
        purgarRemoto: function (clave) {
            if (!esCompartida(clave)) return Promise.resolve(false);
            return escribirRemoto(clave, '[]').then(function () {
                espejo[clave] = '[]';
                delete eliminadas[clave];
                delete pendientes[clave];
                persistirPendientes();
                return true;
            }).catch(function () { return false; });
        },
        purgarRemotoTodo: function (claves) {
            var lista = (claves || COMPARTIDAS).filter(esCompartida);
            return Promise.all(lista.map(function (c) {
                return escribirRemoto(c, '[]').then(function () {
                    espejo[c] = '[]';
                    delete eliminadas[c];
                    delete pendientes[c];
                    persistirPendientes();
                    return true;
                }).catch(function () { return false; });
            }));
        },
        /* Verificar si una clave local tiene datos */
        tieneDatosLocales: function (clave) {
            var v = localStorage.getItem(clave);
            return v !== null && tieneContenido(v);
        },
        /* Forzar subida de datos locales al servidor (sin merge) */
        forzarSubida: function (clave) {
            if (!esCompartida(clave)) return Promise.resolve(false);
            var v = localStorage.getItem(clave) || '';
            console.log('[NXDB] forzarSubida: ' + clave + ' (' + v.length + ' chars)');
            return escribirRemoto(clave, v).then(function () {
                espejo[clave] = v;
                delete pendientes[clave];
                delete eliminadas[clave];
                persistirPendientes();
                console.log('[NXDB] ✓ forzarSubida OK: ' + clave);
                return true;
            }).catch(function (err) {
                console.error('[NXDB] ✗ forzarSubida FALLO: ' + clave, err);
                return false;
            });
        },
        /* Restaurar facturas/RIPS desde backup */
        restaurarBackup: function (clave) {
            var backup = localStorage.getItem(clave + '_backup');
            if (!tieneContenido(backup)) return false;
            try {
                almacenarLocal(clave, backup);
                pendientes[clave] = true;
                persistirPendientes();
                console.log('[NXDB] Restaurado ' + clave + ' desde backup');
                return true;
            } catch(e) { return false; }
        },
        /* Diagnosticar estado de persistencia */
        diagnosticar: function () {
            var info = {};
            ['nexus_facturas', 'nexus_rips_generados', 'nexus_contador_facturas',
             'nexus_contador_prefacturas'].forEach(function(c) {
                var local = localStorage.getItem(c);
                info[c] = {
                    localLength: local ? local.length : 0,
                    localItems: analizar(local) ? (Array.isArray(analizar(local)) ? analizar(local).length : JSON.stringify(analizar(local))) : 0,
                    pendiente: !!pendientes[c],
                    espejoLength: (espejo[c] || '').length
                };
            });
            console.log('[NXDB] Diagnostico:', JSON.stringify(info, null, 2));
            return info;
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