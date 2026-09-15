// ═══════════════════════════════════════════════════════════
// NEXUSMED DIAGNÓSTICO POST-DEPLOY v2.6
// Ejecutar en Console de DevTools (F12) en nexusmed-plto.onrender.com
// ═══════════════════════════════════════════════════════════

console.log('%c═══ NEXUSMED DIAGNÓSTICO POST-DEPLOY v2.6 ═══', 'background:#0d2137;color:#4fc3f7;font-size:16px;padding:8px');

// 1. Verificar versión de nexus_db.js
console.log('%c[1] Verificando versión de nexus_db.js...', 'color:#aaa');
var hasPersistirPendientes = typeof persistirPendientes === 'function' || (typeof NXDB !== 'undefined');
var hasTieneContenido = false;
try {
  // Buscar función tieneContenido en el código fuente
  var scripts = document.querySelectorAll('script');
  for (var i = 0; i < scripts.length; i++) {
    if (scripts[i].src && scripts[i].src.includes('nexus_db')) {
      console.log('  nexus_db.js cargado desde:', scripts[i].src);
    }
  }
} catch(e) {}

// 2. Verificar sessionStorage pendientes
console.log('%c[2] Verificando sessionStorage de pendientes...', 'color:#aaa');
try {
  var pendingData = sessionStorage.getItem('NXDB_pending');
  if (pendingData) {
    var pending = JSON.parse(pendingData);
    console.log('  ✅ NXDB_pending existe en sessionStorage:', Object.keys(pending));
  } else {
    console.warn('  ⚠️ NXDB_pending NO encontrado en sessionStorage — ¿versión vieja?');
  }
} catch(e) {
  console.warn('  ⚠️ Error leyendo sessionStorage:', e);
}

// 3. Verificar facturas en localStorage
console.log('%c[3] Verificando facturas en localStorage...', 'color:#aaa');
try {
  var facturas = JSON.parse(localStorage.getItem('nexus_facturas') || '[]');
  console.log('  Facturas guardadas:', facturas.length);
  if (facturas.length > 0) {
    facturas.forEach(function(f, i) {
      console.log('  [' + i + '] ' + f.numeroFactura + ' | ' + f.paciente + ' | ' + (f.estado||'?') + ' | numAdm=' + (f.numAdmision||'?'));
    });
  }
} catch(e) {
  console.error('  ❌ Error leyendo facturas:', e);
}

// 4. Verificar RIPS en localStorage
console.log('%c[4] Verificando RIPS en localStorage...', 'color:#aaa');
try {
  var rips = JSON.parse(localStorage.getItem('nexus_rips_generados') || '[]');
  console.log('  RIPS guardados:', rips.length);
} catch(e) {
  console.error('  ❌ Error leyendo RIPS:', e);
}

// 5. Verificar contador de facturas
console.log('%c[5] Verificando contador de facturas...', 'color:#aaa');
try {
  var contador = JSON.parse(localStorage.getItem('nexus_contador_facturas') || '{}');
  console.log('  Contador facturas:', JSON.stringify(contador));
} catch(e) {}

// 6. Verificar NXDB.diagnosticar()
console.log('%c[6] Ejecutando NXDB.diagnosticar()...', 'color:#aaa');
if (typeof NXDB !== 'undefined' && NXDB.diagnosticar) {
  var diag = NXDB.diagnosticar();
  console.log('  Diagnóstico NXDB:', diag);
} else {
  console.warn('  ⚠️ NXDB.diagnosticar() NO disponible — ¿nexus_db.js no cargó?');
}

// 7. Verificar botón XML en RIPS (si estamos en esa página)
console.log('%c[7] Verificando botón Descargar XML...', 'color:#aaa');
var xmlBtn = document.querySelector('button[onclick*="descargarXML"]');
if (xmlBtn) {
  console.log('  ✅ Botón "Descargar XML" encontrado en esta página');
} else {
  if (window.location.pathname.includes('rips')) {
    console.warn('  ⚠️ Estás en página RIPS pero NO se encontró el botón XML');
  } else {
    console.log('  (No estás en la página RIPS, saltando verificación)');
  }
}

// 8. Verificar versiones de funciones críticas
console.log('%c[8] Verificando funciones críticas...', 'color:#aaa');
var funcionesRequeridas = [
  {nombre: 'descargarXML', pagina: 'rips.html'},
  {nombre: 'emitirFacturaDefinitiva', pagina: 'facturacion.html'},
  {nombre: 'guardarPreFactura', pagina: 'facturacion.html'}
];
funcionesRequeridas.forEach(function(fn) {
  if (typeof window[fn.nombre] === 'function') {
    console.log('  ✅ ' + fn.nombre + '() disponible');
  } else {
    var msg = '  ' + fn.nombre + '() NO encontrado';
    if (window.location.pathname.includes(fn.pagina.replace('.html',''))) {
      console.error('  ❌' + msg + ' — ESTÁS EN ' + fn.pagina.toUpperCase());
    } else {
      console.log('  ℹ️' + msg + ' (normal si no estás en ' + fn.pagina + ')');
    }
  }
});

console.log('%c═══ DIAGNÓSTICO COMPLETO ═══', 'background:#0d2137;color:#4fc3f7;font-size:14px;padding:4px');
console.log('Si ves ⚠️ o ❌ arriba, los archivos actualizados NO se desplegaron correctamente.');
console.log('Si ves ✅ en todo, el patch v2.6 está funcionando.');
