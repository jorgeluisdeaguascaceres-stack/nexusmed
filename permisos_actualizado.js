/* ============================================================
NEXUSMED IPS - MOTOR GLOBAL DE PERMISOS (ACTUALIZADO)
Incluye módulo CONCILIACIÓN para control de firmas/evoluciones
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
conciliacion: 'Conciliación',
epicrisis: 'Epicrisis',
citas: 'Citas',
egresados: 'Egresados'
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
conciliacion:     { admin: T, recepcion: SV,  medico_general: SV,  enfermeria: SV,  terapia: CVE, especialista: SV },
epicrisis:        { admin: T, recepcion: SV,  medico_general: CVE, enfermeria: SV,  terapia: SV,  especialista: CVE },
citas:            { admin: T, recepcion: CVE, medico_general: CVE, enfermeria: CVE, terapia: CVE, especialista: CVE },
egresados:        { admin: T, recepcion: CVE, medico_general: CVE, enfermeria: CVE, terapia: CVE, especialista: CVE }
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
// Asegurar que conciliacion existe en la matriz guardada
if (!guardada.conciliacion) guardada.conciliacion = base.conciliacion;
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
t.innerHTML = '<b>Permiso denegado</b><br>' + mensaje;
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
icono.innerHTML = '🔒';
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
btn.innerHTML = 'Volver al menú principal';
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
d.style.cssText = 'position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483500;' +
'background:linear-gradient(90deg,#92400e,#b45309);color:#fef3c7;display:flex;align-items:center;' +
'justify-content:center;font:700 11px/1 Inter,sans-serif;letter-spacing:.5px;';
d.textContent = 'modo consulta: su rol (' +
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
NX.filtrarMenu = function (permisos) {
var bloqueadas = T.filter(function (a) { return permisos.indexOf(a) < 0; });
ocultarControles(bloqueadas);
};
NX.filtrarNavegacion = NX.filtrarMenu;
NX.recargar();
window.NX = NX;
})();