/**
 * NexusMed v9.2 - Google Apps Script
 * 
 * ESTRUCTURA DEL SPREADSHEET:
 * 
 * 1) Hoja BASE (NO CAMBIA) - Calendario diario de firma vs nota:
 *    A: NOMBRE Y APELLIDO
 *    B: TIPO (TI DOC)
 *    C: DOCUMENTO (NUMERO)
 *    D: FECHA CALENDARIO
 *    E: FIRMA (Terapia Ocupacional)
 *    F: OCUPACIONAL (evolucion/nota)
 *    G: CANT.
 *    H: FIRMA (Psicologia)
 *    I: PSICOLOGIA (evolucion/nota)
 *    J: CANT.
 *    K: FIRMA (Fonologia)
 *    L: FONOLOGIA (evolucion/nota)
 *    M: CANT.
 *    N: FIRMA (Fisioterapia)
 *    O: FISIOTERAPIA (evolucion/nota)
 *    P: CANT.
 *
 * 2) Hojas mensuales (AGOSTO 2026, SEPTIEMBRE 2026, etc.):
 *    A: FECHA DE PROG
 *    B: NOMBRE Y APELLIDO
 *    C: TI DOC
 *    D: NUMERO
 *    E: TERAPIA OCUPACIONAL (sesiones)
 *    F: AUTORIZACION (Ocupacional)
 *    G: PSICOLOGIA (sesiones)
 *    H: AUTORIZACION (Psicologia)
 *    I: FONOLOGIA (sesiones)
 *    J: AUTORIZACION (Fonologia)
 *    K: FISIOTERAPIA (sesiones)
 *    L: AUTORIZACION (Fisioterapia)
 *    M: FACTURA
 *    N: DIG CIE
 *    O: CUPS TERAPIA OCUPACIONAL
 *    P: CUPS PSICOLOGIA
 *    Q: CUPS TERAPIA FONOAUDIOLOGIA
 *    R: CUPS TERAPIA FISICA
 */

var MONTH_NAMES = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];

function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};
  var action = params.action || '';
  var month = params.month || '';
  
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // DEBUG endpoint - shows all sheet names and what was detected
    if (action === 'debug') {
      var sheets = ss.getSheets();
      var sheetInfo = [];
      for (var i = 0; i < sheets.length; i++) {
        var s = sheets[i];
        var d = s.getDataRange().getValues();
        sheetInfo.push({
          name: s.getName(),
          rows: d.length,
          cols: d.length > 0 ? d[0].length : 0,
          headerRow: d.length > 0 ? d[0].slice(0, 18).join(' | ') : '',
          isBase: s.getName().toUpperCase() === 'BASE',
          isMonth: isMonthSheet(s.getName())
        });
      }
      return jsonResponse({
        action: 'debug',
        spreadsheetName: ss.getName(),
        totalSheets: sheets.length,
        sheets: sheetInfo,
        detectedMonths: detectMonthSheets(ss),
        requestedMonth: month
      });
    }
    
    // Action: list available months
    if (action === 'months') {
      var months = detectMonthSheets(ss);
      return jsonResponse({
        months: months,
        totalSheets: ss.getSheets().length,
        sheetNames: ss.getSheets().map(function(s) { return s.getName(); })
      });
    }
    
    // Find BASE sheet (for calendar/firma data)
    var baseSheet = ss.getSheetByName('BASE');
    var baseData = baseSheet ? parseBaseSheet(baseSheet) : [];
    var baseInfo = baseSheet ? {found: true, rows: baseSheet.getLastRow(), name: baseSheet.getName()} : {found: false};
    
    // Find monthly sheet (for informe data: sesiones, autorizacion, factura, etc.)
    var months = detectMonthSheets(ss);
    var monthSheetName = '';
    var monthSheet = null;
    
    // Try exact match first
    if (month) {
      monthSheet = ss.getSheetByName(month);
      if (monthSheet) {
        monthSheetName = month;
      } else {
        // Try case-insensitive and trimmed match
        var allSheets = ss.getSheets();
        for (var i = 0; i < allSheets.length; i++) {
          if (allSheets[i].getName().trim().toUpperCase() === month.trim().toUpperCase()) {
            monthSheet = allSheets[i];
            monthSheetName = allSheets[i].getName();
            break;
          }
        }
      }
    }
    
    // If no month specified or not found, use first detected month
    if (!monthSheet && months.length > 0) {
      monthSheet = ss.getSheetByName(months[0]);
      monthSheetName = months[0];
    }
    
    // Still no monthly sheet? Try old INFORME
    if (!monthSheet && months.length === 0) {
      var informeSheet = ss.getSheetByName('INFORME');
      if (informeSheet) {
        var informeData = readInformeSheet(informeSheet);
        return jsonResponse({
          base: baseData,
          informe: informeData,
          months: months,
          activeMonth: '',
          baseInfo: baseInfo,
          informeInfo: {found: true, type: 'old_INFORME', rows: informeSheet.getLastRow()},
          debug: 'Usando hoja INFORME antigua (no se detectaron hojas mensuales)'
        });
      }
      return jsonResponse({
        error: 'No se encontraron hojas mensuales ni la hoja INFORME',
        availableSheetNames: ss.getSheets().map(function(s) { return s.getName(); }),
        tip: 'Las hojas mensuales deben llamarse AGOSTO 2026, SEPTIEMBRE 2026, etc. (nombre del mes en mayusculas + espacio + año de 4 digitos)'
      });
    }
    
    // Read the monthly sheet
    var informeData = monthSheet ? parseMonthlySheet(monthSheet) : [];
    var monthInfo = monthSheet ? {found: true, type: 'monthly', name: monthSheet.getName(), rows: monthSheet.getLastRow(), dataRows: informeData.length} : {found: false};
    
    return jsonResponse({
      base: baseData,
      informe: informeData,
      months: months,
      activeMonth: monthSheetName,
      baseInfo: baseInfo,
      monthInfo: monthInfo
    });
    
  } catch(err) {
    return jsonResponse({
      error: err.toString(),
      stack: err.stack || '',
      params: params
    });
  }
}

/**
 * Check if a sheet name looks like a month sheet
 */
function isMonthSheet(name) {
  var n = name.trim().toUpperCase();
  for (var m = 0; m < MONTH_NAMES.length; m++) {
    if (n.indexOf(MONTH_NAMES[m]) === 0) {
      var rest = n.substring(MONTH_NAMES[m].length).trim();
      if (/^\d{4}$/.test(rest)) return true;
    }
  }
  return false;
}

/**
 * Detect sheets that look like month names: "AGOSTO 2026", "SEPTIEMBRE 2026", etc.
 */
function detectMonthSheets(ss) {
  var sheets = ss.getSheets();
  var months = [];
  
  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    if (isMonthSheet(name)) {
      months.push(name); // Keep original case from the sheet
    }
  }
  
  // Sort chronologically
  months.sort(function(a, b) {
    var aUp = a.toUpperCase();
    var bUp = b.toUpperCase();
    var aMonth = -1, bMonth = -1;
    var aYear = 0, bYear = 0;
    
    for (var i = 0; i < MONTH_NAMES.length; i++) {
      if (aUp.indexOf(MONTH_NAMES[i]) === 0) {
        aMonth = i;
        aYear = parseInt(aUp.substring(MONTH_NAMES[i].length).trim()) || 0;
      }
      if (bUp.indexOf(MONTH_NAMES[i]) === 0) {
        bMonth = i;
        bYear = parseInt(bUp.substring(MONTH_NAMES[i].length).trim()) || 0;
      }
    }
    
    if (aYear !== bYear) return aYear - bYear;
    return aMonth - bMonth;
  });
  
  return months;
}

/**
 * Parse BASE sheet - ESTRUCTURA ORIGINAL (NO CAMBIA)
 * A=NOMBRE, B=TI_DOC, C=NUMERO, D=FECHA,
 * E=FIRMA_OCUP, F=OCUPACIONAL, G=CANT_OCUP,
 * H=FIRMA_PSICOL, I=PSICOLOGIA, J=CANT_PSICOL,
 * K=FIRMA_FONO, L=FONOLOGIA, M=CANT_FONO,
 * N=FIRMA_FISIO, O=FISIOTERAPIA, P=CANT_FISIO
 */
function parseBaseSheet(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 3) return [];
  
  // Find the data start row (skip merged header rows)
  var startRow = 2; // Default: data starts at row 3 (index 2)
  for (var i = 0; i < Math.min(5, data.length); i++) {
    var row = data[i];
    var nameVal = String(row[0] || '').trim();
    // Look for a row where col A has a real name and col D has a date
    if (nameVal.length > 2 && row[3] != null && row[3] !== '') {
      // Check if row has numeric data in therapy columns
      var hasData = false;
      for (var c = 4; c < 16; c++) {
        if (row[c] != null && row[c] !== '' && typeof row[c] === 'number') {
          hasData = true;
          break;
        }
      }
      // Or at least a valid-looking name (not a header keyword)
      if (hasData || (nameVal.toUpperCase().indexOf('NOMBRE') < 0 && nameVal.toUpperCase().indexOf('FIRMA') < 0 && nameVal.toUpperCase().indexOf('ESPECIALIDAD') < 0)) {
        startRow = i;
        break;
      }
    }
  }
  
  var result = [];
  
  for (var i = startRow; i < data.length; i++) {
    var row = data[i];
    if (!row) continue;
    
    var nombre = String(row[0] || '').trim();
    var tipoDoc = String(row[1] || '').trim();
    var numero = String(row[2] || '').trim();
    var fecha = row[3];
    
    // Skip empty rows and header rows
    if (!nombre || nombre.length < 2) continue;
    if (nombre.toUpperCase().indexOf('NOMBRE') >= 0) continue;
    if (nombre.toUpperCase().indexOf('FIRMA') >= 0) continue;
    if (nombre.toUpperCase().indexOf('ESPECIALIDAD') >= 0) continue;
    if (!numero && !fecha) continue;
    
    var rec = {
      nombre: nombre,
      tipo_doc: tipoDoc,
      documento: numero,
      fecha: formatDate(fecha),
      firma_ocupacional: toNumber(row[4]),
      ocupacional: toNumber(row[5]),
      cant_ocupacional: toNumber(row[6]),
      firma_psicologia: toNumber(row[7]),
      psicologia: toNumber(row[8]),
      cant_psicologia: toNumber(row[9]),
      firma_fonologia: toNumber(row[10]),
      fonologia: toNumber(row[11]),
      cant_fonologia: toNumber(row[12]),
      firma_fisioterapia: toNumber(row[13]),
      fisioterapia: toNumber(row[14]),
      cant_fisioterapia: toNumber(row[15])
    };
    
    result.push(rec);
  }
  
  return result;
}

/**
 * Parse monthly sheet (AGOSTO 2026, SEPTIEMBRE 2026, etc.)
 * This is what used to be the INFORME sheet, now per month.
 * New structure (18 cols: A-R):
 * A: FECHA DE PROG
 * B: NOMBRE Y APELLIDO
 * C: TI DOC
 * D: NUMERO
 * E: TERAPIA OCUPACIONAL (sesiones)
 * F: AUTORIZACION (Ocupacional)
 * G: PSICOLOGIA (sesiones)
 * H: AUTORIZACION (Psicologia)
 * I: FONOLOGIA (sesiones)
 * J: AUTORIZACION (Fonologia)
 * K: FISIOTERAPIA (sesiones)
 * L: AUTORIZACION (Fisioterapia)
 * M: FACTURA
 * N: DIG CIE
 * O: CUPS TERAPIA OCUPACIONAL
 * P: CUPS PSICOLOGIA
 * Q: CUPS TERAPIA FONOAUDIOLOGIA
 * R: CUPS TERAPIA FISICA
 */
function parseMonthlySheet(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  
  var headers = data[0];
  var headerStr = headers.join('|').toUpperCase();
  
  // Detect structure based on headers
  var hasNewStructure = headerStr.indexOf('AUTORIZACION') >= 0 || 
                        headerStr.indexOf('FACTURA') >= 0 ||
                        headerStr.indexOf('CUPS') >= 0 ||
                        headerStr.indexOf('DIG CIE') >= 0 ||
                        headerStr.indexOf('DIG_CIE') >= 0;
  
  var hasFecha = headerStr.indexOf('FECHA DE PROG') >= 0 ||
                 headerStr.indexOf('FECHA DE PROGRAMACION') >= 0 ||
                 headerStr.indexOf('FECHA PROG') >= 0 ||
                 headerStr.indexOf('FECHAPROG') >= 0;
  
  // Also detect by checking if column A header contains 'FECHA' and column B contains 'NOMBRE'
  if (!hasFecha && headers.length > 1) {
    var h0 = String(headers[0] || '').trim().toUpperCase();
    var h1 = String(headers[1] || '').trim().toUpperCase();
    if (h0.indexOf('FECHA') >= 0 && h1.indexOf('NOMBRE') >= 0) {
      hasFecha = true;
    }
  }
  
  var result = [];
  
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row) continue;
    
    // Skip empty rows
    var hasAnyData = false;
    for (var c = 0; c < Math.min(18, row.length); c++) {
      if (row[c] != null && row[c] !== '') {
        hasAnyData = true;
        break;
      }
    }
    if (!hasAnyData) continue;
    
    var nombre, tipoDoc, numero, fechaProg;
    
    if (hasFecha && hasNewStructure) {
      // NEW monthly structure: A=FECHA, B=NOMBRE, C=TI_DOC, D=NUMERO
      nombre = String(row[1] || '').trim();
      tipoDoc = String(row[2] || '').trim();
      numero = String(row[3] || '').trim();
      fechaProg = formatDate(row[0]);
    } else if (hasNewStructure) {
      // OLD INFORME structure: A=NOMBRE, B=TI_DOC, C=NUMERO
      nombre = String(row[0] || '').trim();
      tipoDoc = String(row[1] || '').trim();
      numero = String(row[2] || '').trim();
      fechaProg = '';
    } else {
      // VERY OLD INFORME structure
      nombre = String(row[0] || '').trim();
      tipoDoc = String(row[1] || '').trim();
      numero = String(row[2] || '').trim();
      fechaProg = '';
    }
    
    // Skip header-like rows
    if (!nombre || nombre.length < 2) continue;
    if (nombre.toUpperCase().indexOf('NOMBRE') >= 0) continue;
    if (nombre.toUpperCase().indexOf('TOTAL') >= 0) continue;
    
    var rec;
    
    if (hasFecha && hasNewStructure) {
      rec = {
        nombre: nombre,
        tipo_doc: tipoDoc,
        documento: numero,
        fecha_prog: fechaProg,
        sesiones_ocupacional: toNumber(row[4]),
        autorizacion_ocupacional: String(row[5] || '').trim(),
        sesiones_psicologia: toNumber(row[6]),
        autorizacion_psicologia: String(row[7] || '').trim(),
        sesiones_fonologia: toNumber(row[8]),
        autorizacion_fonologia: String(row[9] || '').trim(),
        sesiones_fisioterapia: toNumber(row[10]),
        autorizacion_fisioterapia: String(row[11] || '').trim(),
        factura: String(row[12] || '').trim(),
        dig_cie: String(row[13] || '').trim(),
        cups_ocupacional: String(row[14] || '').trim(),
        cups_psicologia: String(row[15] || '').trim(),
        cups_fonologia: String(row[16] || '').trim(),
        cups_fisioterapia: String(row[17] || '').trim()
      };
    } else if (hasNewStructure) {
      rec = {
        nombre: nombre,
        tipo_doc: tipoDoc,
        documento: numero,
        fecha_prog: '',
        sesiones_ocupacional: toNumber(row[4]),
        autorizacion_ocupacional: String(row[5] || '').trim(),
        sesiones_psicologia: toNumber(row[6]),
        autorizacion_psicologia: String(row[7] || '').trim(),
        sesiones_fonologia: toNumber(row[8]),
        autorizacion_fonologia: String(row[9] || '').trim(),
        sesiones_fisioterapia: toNumber(row[10]),
        autorizacion_fisioterapia: String(row[11] || '').trim(),
        factura: String(row[3] || '').trim(),
        dig_cie: String(row[12] || '').trim(),
        cups_ocupacional: String(row[13] || '').trim(),
        cups_psicologia: String(row[14] || '').trim(),
        cups_fonologia: String(row[15] || '').trim(),
        cups_fisioterapia: String(row[16] || '').trim()
      };
    } else {
      rec = {
        nombre: nombre,
        tipo_doc: tipoDoc,
        documento: numero,
        fecha_prog: '',
        sesiones_ocupacional: toNumber(row[3]),
        autorizacion_ocupacional: '',
        sesiones_psicologia: toNumber(row[4]),
        autorizacion_psicologia: '',
        sesiones_fonologia: toNumber(row[5]),
        autorizacion_fonologia: '',
        sesiones_fisioterapia: toNumber(row[6]),
        autorizacion_fisioterapia: '',
        factura: '',
        dig_cie: '',
        cups_ocupacional: '',
        cups_psicologia: '',
        cups_fonologia: '',
        cups_fisioterapia: ''
      };
    }
    
    result.push(rec);
  }
  
  return result;
}

/**
 * Read old INFORME sheet (backward compatibility)
 */
function readInformeSheet(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  
  var headers = data[0];
  var headerStr = headers.join('|').toUpperCase();
  var hasNewStructure = headerStr.indexOf('AUTORIZACION') >= 0 || 
                        headerStr.indexOf('FACTURA') >= 0 ||
                        headerStr.indexOf('CUPS') >= 0;
  
  var result = [];
  
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row || !row[0]) continue;
    
    var nombre = String(row[0] || '').trim();
    if (!nombre || nombre.length < 2) continue;
    if (nombre.toUpperCase().indexOf('NOMBRE') >= 0) continue;
    if (nombre.toUpperCase().indexOf('TOTAL') >= 0) continue;
    
    var rec;
    
    if (hasNewStructure) {
      rec = {
        nombre: nombre,
        tipo_doc: String(row[1] || '').trim(),
        documento: String(row[2] || '').trim(),
        fecha_prog: '',
        factura: String(row[3] || '').trim(),
        sesiones_ocupacional: toNumber(row[4]),
        autorizacion_ocupacional: String(row[5] || '').trim(),
        sesiones_psicologia: toNumber(row[6]),
        autorizacion_psicologia: String(row[7] || '').trim(),
        sesiones_fonologia: toNumber(row[8]),
        autorizacion_fonologia: String(row[9] || '').trim(),
        sesiones_fisioterapia: toNumber(row[10]),
        autorizacion_fisioterapia: String(row[11] || '').trim(),
        dig_cie: String(row[12] || '').trim(),
        cups_ocupacional: String(row[13] || '').trim(),
        cups_psicologia: String(row[14] || '').trim(),
        cups_fonologia: String(row[15] || '').trim(),
        cups_fisioterapia: String(row[16] || '').trim()
      };
    } else {
      rec = {
        nombre: nombre,
        tipo_doc: String(row[1] || '').trim(),
        documento: String(row[2] || '').trim(),
        fecha_prog: '',
        factura: '',
        sesiones_ocupacional: toNumber(row[3]),
        autorizacion_ocupacional: '',
        sesiones_psicologia: toNumber(row[4]),
        autorizacion_psicologia: '',
        sesiones_fonologia: toNumber(row[5]),
        autorizacion_fonologia: '',
        sesiones_fisioterapia: toNumber(row[6]),
        autorizacion_fisioterapia: '',
        dig_cie: '',
        cups_ocupacional: '',
        cups_psicologia: '',
        cups_fonologia: '',
        cups_fisioterapia: ''
      };
    }
    
    result.push(rec);
  }
  
  return result;
}

// ===== HELPERS =====

function toNumber(val) {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') return val;
  var num = Number(String(val).trim());
  return isNaN(num) ? 0 : num;
}

function formatDate(val) {
  if (val == null || val === '') return '';
  if (typeof val === 'number') {
    var date = new Date(1899, 11, 30);
    date.setDate(date.getDate() + val);
    var y = date.getFullYear();
    var m = ('0' + (date.getMonth() + 1)).slice(-2);
    var d = ('0' + date.getDate()).slice(-2);
    return y + '-' + m + '-' + d;
  }
  if (val instanceof Date) {
    var y = val.getFullYear();
    var m = ('0' + (val.getMonth() + 1)).slice(-2);
    var d = ('0' + val.getDate()).slice(-2);
    return y + '-' + m + '-' + d;
  }
  return String(val).trim();
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}