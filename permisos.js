/* ============================================================
   NEXUSMED IPS - MOTOR GLOBAL DE PERMISOS
   Lee la Matriz Global (nexus_permisos) creada en Configuracion
   y la APLICA en todos los modulos del sistema.

   Acciones:  C = Crear   V = Ver   E = Editar   B = Borrar
   ============================================================ */
(function () {
    'use strict';

    var PERMISOS_KEY = 'nexus_permisos';
    var SESION_KEY = 'nexus_sesion';

    var ROLES = ['admin', 'recepcion', 'medico_general', 'enfermeria', 'terapia', 'especialista'];

    var NOMBRE_ROL = {
        admin: 'Administrador',
        recepcion: 'Recepcionista',
        medico_general: 'Médico General',
        enfermeria: 'Enfermería',
        terapia: 'Terapia',
        especialista: 'Especialista'
    };

    var NOMBRE_MODULO = {
        admisiones: 'Admisiones',
        configuracion: 'Configuración',
        historia_clinica: 'Historia Clínica',
        evoluciones: 'Evoluciones',
        notas_enfermeria: 'Notas de Enfermería',
        terapia: 'Terapia',
        epicrisis: 'Epicrisis',
        citas: 'Citas',
        egresados: 'Egresados',
        facturacion: 'Facturación'
    };

    var T = ['C', 'V', 'E', 'B'];
    var CVE = ['C', 'V', 'E'];
    var SV = ['V'];
    var NO = [];

    /* Matriz oficial de respaldo: identica a la de configuracion.html */
    function matrizOficial() {
        return {
            admisiones:       { admin: T, recepcion: CVE, medico_general: NO,  enfermeria: NO,  terapia: NO,  especialista: NO },
            configuracion:    { admin: T, recepcion: NO,  medico_general: NO,  enfermeria: NO,  terapia: NO,  especialista: NO },
            historia_clinica: { admin: T, recepcion: SV,  medico_general: CVE, enfermeria: SV,  terapia: SV,  especialista: CVE },
            evoluciones:      { admin: T, recepcion: SV,  medico_general: CVE, enfermeria: SV,  terapia: SV,  especialista: CVE },
            notas_enfermeria: { admin: T, recepcion: SV,  medico_general: SV,  enfermeria: CVE, terapia: SV,  especialista: SV },
            terapia:          { admin: T, recepcion: SV,  medico_general: SV,  enfermeria: NO,  terapia: CVE, especialista: SV },
            epicrisis:        { admin: T, recepcion: SV,  medico_general: CVE, enfermeria: SV,  terapia: SV,  especialista: CVE },
            citas:            { admin: T, recepcion: CVE, medico_general: CVE, enfermeria: CVE, terapia: CVE, especialista: CVE },
            egresados:        { admin: T, recepcion: CVE, medico_general: CVE, enfermeria: CVE, terapia: CVE, especialista: CVE },
            facturacion:      { admin: T, recepcion: SV,  medico_general: SV,  enfermeria: NO,  terapia: SV,  especialista: SV }
        };
    }

    /* Roles heredados de versiones anteriores */
    function normalizarRol(rol) {
        if (!rol) return 'recepcion';
        var r = String(rol).toLowerCase().trim();
        if (r === 'medico' || r === 'médico' || r === 'medico general' || r === 'médico general') return 'medico_general';
        if (r === 'enfermera' || r === 'enfermero' || r === 'enfermería') return 'enfermeria';
        if (r === 'terapista' || r === 'terapeuta' || r === 'fisioterapeuta') return 'terapia';
        if (r === 'administrador' || r === 'administrator') return 'admin';
        if (r === 'recepcionista' || r === 'recepción') return 'recepcion';
        if (ROLES.indexOf(r) >= 0) return r;
        return 'recepcion';
    }

    function cargarMatriz() {
        var base = matrizOficial();
        var guardada = null;
        try { guardada = JSON.parse(localStorage.getItem(PERMISOS_KEY) || 'null'); } catch (e) { guardada = null; }
        if (!guardada || typeof guardada !== 'object') return base;
        Object.keys(base).forEach(function (m) {
            if (!guardada[m] || typeof guardada[m] !== 'object') { guardada[m] = base[m]; return; }
            ROLES.forEach(function (r) {
                if (!Array.isArray(guardada[m][r])) guardada[m][r] = base[m][r];
            });
        });
        return guardada;
    }

    function sesionActual() {
        try { return JSON.parse(localStorage.getItem(SESION_KEY) || 'null'); } catch (e) { return null; }
    }

    var NX = {
        modulo: null,
        rol: 'recepcion',
        matriz: matrizOficial()
    };

    NX.normalizarRol = normalizarRol;
    NX.nombreRol = function (rol) { return NOMBRE_ROL[normalizarRol(rol)] || String(rol || '').toUpperCase(); };

    NX.recargar = function () {
        var s = sesionActual();
        NX.rol = normalizarRol(s && s.rol);
        NX.matriz = cargarMatriz();
    };

    /* puede('admisiones','C')  ->  true / false */
    NX.puede = function (modulo, accion) {
        var m = NX.matriz[modulo];
        if (!m) return true;                 // modulo no gobernado por la matriz
        var lista = m[NX.rol];
        if (!Array.isArray(lista)) return false;
        return lista.indexOf(String(accion).toUpperCase()) >= 0;
    };

    NX.permisosDe = function (modulo) {
        var m = NX.matriz[modulo];
        if (!m || !Array.isArray(m[NX.rol])) return [];
        return m[NX.rol].slice();
    };

    /* ---------------- Aviso flotante ---------------- */
    NX.aviso = function (mensaje) {
        var t = document.getElementById('nxAvisoPermiso');
        if (!t) {
            t = document.createElement('div');
            t.id = 'nxAvisoPermiso';
            t.style.cssText = 'position:fixed;top:24px;right:24px;z-index:2147483000;max-width:340px;' +
                'background:#122a45;border:1px solid #e63946;border-left:4px solid #e63946;color:#e8f1f8;' +
                'padding:14px 18px;border-radius:12px;font:600 13px/1.5 Inter,Segoe UI,sans-serif;' +
                'box-shadow:0 18px 40px rgba(0,0,0,.55);opacity:0;transform:translateY(-14px);' +
                'transition:opacity .25s ease,transform .25s ease;';
            document.body.appendChild(t);
        }
        t.innerHTML = '<i class="fas fa-lock" style="color:#e63946;margin-right:8px"></i>' + mensaje;
        requestAnimationFrame(function () { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
        clearTimeout(t._nxTimer);
        t._nxTimer = setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translateY(-14px)'; }, 3600);
    };

    /* ---------------- Bloqueo total del modulo ---------------- */
    NX.bloquearModulo = function (modulo) {
        if (document.getElementById('nxBloqueoAcceso')) return;
        var nombre = NOMBRE_MODULO[modulo] || 'este módulo';
        var ov = document.createElement('div');
        ov.id = 'nxBloqueoAcceso';
        ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(4,12,24,.94);' +
            'backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:24px;' +
            'font-family:Inter,Segoe UI,sans-serif;';
        var caja = document.createElement('div');
        caja.style.cssText = 'max-width:520px;width:100%;text-align:center;background:linear-gradient(160deg,#0d2137,#122a45);' +
            'border:1px solid #1a3a5c;border-radius:22px;padding:48px 40px;box-shadow:0 30px 80px rgba(0,0,0,.6);';
        var titulo = document.createElement('h2');
        titulo.textContent = 'Acceso restringido';
        titulo.style.cssText = 'margin:0 0 14px;font-size:28px;font-weight:800;color:#e8f1f8;letter-spacing:-.5px;';
        var icono = document.createElement('div');
        icono.innerHTML = '<i class="fas fa-shield-halved"></i>';
        icono.style.cssText = 'width:88px;height:88px;margin:0 auto 26px;border-radius:50%;display:flex;' +
            'align-items:center;justify-content:center;font-size:38px;color:#e63946;' +
            'background:rgba(230,57,70,.12);border:1px solid rgba(230,57,70,.4);';
        var p1 = document.createElement('p');
        p1.style.cssText = 'margin:0 0 10px;color:#9fb8cd;font-size:15px;line-height:1.7;';
        p1.textContent = 'Su rol no tiene permiso para ver el módulo de ' + nombre + '.';
        var p2 = document.createElement('p');
        p2.style.cssText = 'margin:0 0 30px;color:#6d8ba6;font-size:13px;line-height:1.7;';
        p2.textContent = 'Rol actual: ' + (NOMBRE_ROL[NX.rol] || NX.rol) + '. Solicite autorización al Administrador en la Matriz Global de Permisos.';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.innerHTML = '<i class="fas fa-arrow-left" style="margin-right:8px"></i>Volver al menú principal';
        btn.style.cssText = 'cursor:pointer;border:none;border-radius:12px;padding:15px 30px;font:700 14px Inter,sans-serif;' +
            'color:#03202c;background:linear-gradient(135deg,#00b4d8,#0090b3);box-shadow:0 12px 28px rgba(0,180,216,.35);';
        btn.addEventListener('click', function () { window.location.href = 'menu.html'; });
        caja.appendChild(icono); caja.appendChild(titulo); caja.appendChild(p1); caja.appendChild(p2); caja.appendChild(btn);
        ov.appendChild(caja);
        document.body.appendChild(ov);
        document.body.style.overflow = 'hidden';
    };

    /* ---------------- Cinta "Solo lectura" ---------------- */
    NX.cintaSoloLectura = function (permisos) {
        if (document.getElementById('nxCintaPermisos')) return;
        var faltan = [];
        if (permisos.indexOf('C') < 0) faltan.push('crear');
        if (permisos.indexOf('E') < 0) faltan.push('editar');
        if (permisos.indexOf('B') < 0) faltan.push('eliminar');
        if (!faltan.length) return;
        var d = document.createElement('div');
        d.id = 'nxCintaPermisos';
        d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483000;' +
            'background:linear-gradient(90deg,rgba(255,183,0,.16),rgba(255,183,0,.06));' +
            'border-top:1px solid rgba(255,183,0,.45);color:#ffd479;padding:10px 18px;text-align:center;' +
            'font:600 12.5px Inter,Segoe UI,sans-serif;letter-spacing:.2px;';
        d.innerHTML = '<i class="fas fa-eye" style="margin-right:8px"></i>Modo consulta: su rol (' +
            (NOMBRE_ROL[NX.rol] || NX.rol) + ') no puede ' + faltan.join(', ') + ' en este módulo.';
        document.body.appendChild(d);
    };

    /* ---------------- Blindaje de funciones ---------------- */
    function bloquearFuncion(nombre, accion, modulo) {
        var original = window[nombre];
        if (typeof original !== 'function') return;
        var verbo = { C: 'crear registros', E: 'editar registros', B: 'eliminar registros', V: 'consultar' }[accion] || 'esta acción';
        window[nombre] = function () {
            NX.aviso('Permiso denegado: su rol no puede ' + verbo + ' en ' + (NOMBRE_MODULO[modulo] || 'este módulo') + '.');
            return false;
        };
        window[nombre]._nxBloqueada = true;
        window[nombre]._nxOriginal = original;
    }

    /* ---------------- Ocultar controles ---------------- */
    function ocultarControles(bloqueadas) {
        if (!bloqueadas.length) return;
        var nodos = document.querySelectorAll('[onclick]');
        for (var i = 0; i < nodos.length; i++) {
            var el = nodos[i];
            if (el._nxRevisado === bloqueadas.length) continue;
            var code = el.getAttribute('onclick') || '';
            for (var j = 0; j < bloqueadas.length; j++) {
                var re = new RegExp('(^|[^\\w.])' + bloqueadas[j] + '\\s*\\(');
                if (re.test(code)) {
                    el.style.display = 'none';
                    el.setAttribute('data-nx-oculto', '1');
                    break;
                }
            }
            el._nxRevisado = bloqueadas.length;
        }
    }

    /* ---------------- Arranque por pagina ---------------- */
    /* NX.iniciar('admisiones', { C:['registrarAdmision'], E:[...], B:[...] }) */
    NX.iniciar = function (modulo, mapa) {
        NX.recargar();
        NX.modulo = modulo;
        mapa = mapa || {};

        var permisos = NX.permisosDe(modulo);
        var sinVer = !NX.puede(modulo, 'V');
        var bloqueadas = [];

        ['C', 'E', 'B'].forEach(function (accion) {
            var lista = mapa[accion] || [];
            var permitido = !sinVer && NX.puede(modulo, accion);
            if (permitido) return;
            lista.forEach(function (fn) {
                bloquearFuncion(fn, accion, modulo);
                if (bloqueadas.indexOf(fn) < 0) bloqueadas.push(fn);
            });
        });

        if (sinVer) {
            NX.bloquearModulo(modulo);
            return;
        }

        ocultarControles(bloqueadas);
        if (bloqueadas.length) {
            var obs = new MutationObserver(function () { ocultarControles(bloqueadas); });
            obs.observe(document.body, { childList: true, subtree: true });
            setInterval(function () { ocultarControles(bloqueadas); }, 1200);
        }
        NX.cintaSoloLectura(permisos);
    };

    /* ---------------- Menu principal ---------------- */
    var RUTA_MODULO = {
        'admisiones.html': 'admisiones',
        'configuracion.html': 'configuracion',
        'historias_clinicas.html': 'historia_clinica',
        'evolucion.html': 'evoluciones',
        'notas_enfermeria.html': 'notas_enfermeria',
        'terapias.html': 'terapia',
        'epicrisis.html': 'epicrisis',
        'citas.html': 'citas',
        'egresados.html': 'egresados',
        'facturacion.html': 'facturacion'
    };

    NX.filtrarMenu = function () {
        NX.recargar();
        Object.keys(RUTA_MODULO).forEach(function (ruta) {
            if (NX.puede(RUTA_MODULO[ruta], 'V')) return;
            var nav = document.querySelectorAll('a[href="' + ruta + '"]');
            for (var i = 0; i < nav.length; i++) nav[i].style.display = 'none';
            var cards = document.querySelectorAll('[onclick]');
            for (var k = 0; k < cards.length; k++) {
                if ((cards[k].getAttribute('onclick') || '').indexOf(ruta) >= 0) cards[k].style.display = 'none';
            }
        });
    };

    /* Filtra la barra lateral en cualquier pagina que la tenga */
    NX.filtrarNavegacion = NX.filtrarMenu;

    NX.recargar();
    window.NX = NX;
})();