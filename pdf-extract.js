// Version para navegador de lib/pdfExtract.js: misma logica de deteccion
// (heuristica de "mejor esfuerzo", igual que la app local), pero la lectura
// del PDF corre en el propio navegador con pdfjs-dist en vez de en un servidor.

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

export async function extractText(fileOrBlob) {
  let doc = null;
  try {
    const buffer = await fileOrBlob.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false });
    doc = await loadingTask.promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => it.str).join(' '));
    }
    return pages.join('\n');
  } catch (err) {
    console.error('extractText fallo:', err.message);
    return '';
  } finally {
    if (doc) doc.destroy().catch(() => {});
  }
}

export function normalizeAmount(raw) {
  let s = raw.trim().replace(/[^\d.,]/g, '');
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = s.split(',');
    if (parts[parts.length - 1].length <= 2) {
      s = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasDot) {
    const parts = s.split('.');
    if (parts.length > 1 && parts[parts.length - 1].length === 3) {
      s = parts.join('');
    }
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function findLabeled(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function collectCodes(text) {
  const found = new Set();
  const re = /\b(?=[A-Z0-9\-\/]{4,18}\b)(?=[A-Z0-9\-\/]*[0-9])[A-Z0-9][A-Z0-9\-\/]{3,17}\b/g;
  let m;
  while ((m = re.exec(text.toUpperCase()))) {
    const val = m[0];
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(val)) continue;
    found.add(val);
    if (found.size >= 25) break;
  }
  return Array.from(found);
}

function collectAmounts(text) {
  const found = new Map();
  const re = /(?:\$|ARS|USD|U\$S|US\$)?\s*\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\b/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0].trim();
    const value = normalizeAmount(raw);
    if (value === null || value <= 0) continue;
    const key = value.toFixed(2);
    if (!found.has(key)) found.set(key, { raw, value });
    if (found.size >= 25) break;
  }
  return Array.from(found.values()).sort((a, b) => b.value - a.value);
}

function collectDates(text) {
  const found = new Set();
  const re = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/g;
  let m;
  while ((m = re.exec(text))) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    d = d.padStart(2, '0');
    mo = mo.padStart(2, '0');
    if (parseInt(mo, 10) > 12 || parseInt(d, 10) > 31) continue;
    found.add(`${y}-${mo}-${d}`);
    if (found.size >= 15) break;
  }
  return Array.from(found).sort();
}

const NUM_ABBR = '(?:n(?:ro|ros|um(?:ero)?)?\\.?|°|º)';
const SEP = '\\s*[:#\\-]?\\s*';
const CODE = '([A-Z0-9][A-Z0-9\\-\\/]{1,17})';

function labelRe(keyword) {
  return new RegExp(`${keyword}\\s*(?:${NUM_ABBR})?${SEP}${CODE}`, 'i');
}

const LABEL_PATTERNS = {
  presupuesto: [labelRe('presupuesto'), labelRe('cotizaci[oó]n')],
  orden_compra: [labelRe('orden\\s+de\\s+compra'), labelRe('\\bo\\.?c\\.?')],
  factura: [labelRe('factura')],
};

const TOTAL_PATTERNS = [
  /total\s+con\s+iva[^0-9]{0,12}(\d[\d.,]*\d)/i,
  /total\s+c\/iva[^0-9]{0,12}(\d[\d.,]*\d)/i,
  /precio\s+final[^0-9]{0,12}(\d[\d.,]*\d)/i,
  /total\s+a\s+pagar[^0-9]{0,12}(\d[\d.,]*\d)/i,
  /\btotal\b[^0-9]{0,12}(\d[\d.,]*\d)/i,
  /\bimporte\b[^0-9]{0,12}(\d[\d.,]*\d)/i,
];

const SUBTOTAL_PATTERNS = [
  /sub\s*total[^0-9]{0,12}(\d[\d.,]*\d)/i,
  /neto\s+gravado[^0-9]{0,12}(\d[\d.,]*\d)/i,
  /monto\s+sin\s+iva[^0-9]{0,12}(\d[\d.,]*\d)/i,
];

const DESC_LABELS = [
  /descripci[oó]n\s+del\s+trabajo\s*[:#\-]\s*/i,
  /descripci[oó]n\s*[:#\-]\s*/i,
  /detalle\s*[:#\-]\s*/i,
  /concepto\s*[:#\-]\s*/i,
  /trabajo\s+a\s+realizar\s*[:#\-]\s*/i,
  /objeto\s*[:#\-]\s*/i,
];

const DESC_STOP = /\b(sub\s*total|total|iva|importe|monto|presupuesto\s*n|orden\s+de\s+compra|fecha|forma\s+de\s+pago|condiciones|validez|firma)\b/i;

function guessDescripcion(text) {
  for (const labelRe of DESC_LABELS) {
    const m = labelRe.exec(text);
    if (!m) continue;
    let chunk = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const stop = DESC_STOP.exec(chunk);
    if (stop && stop.index > 5) chunk = chunk.slice(0, stop.index);
    chunk = chunk.replace(/\s+/g, ' ').trim();
    if (chunk.length <= 280) return chunk.length >= 6 ? chunk : '';
    const corte = chunk.lastIndexOf(' ', 280);
    return chunk.slice(0, corte > 0 ? corte : 280).trim() + '…';
  }
  return '';
}

export function guessCandidates(text, tipo) {
  const codes = collectCodes(text);
  const amounts = collectAmounts(text);
  const dates = collectDates(text);

  const numeroRaw = findLabeled(text, LABEL_PATTERNS[tipo] || []);
  const totalRaw = findLabeled(text, TOTAL_PATTERNS);
  const subtotalRaw = findLabeled(text, SUBTOTAL_PATTERNS);

  return {
    codes,
    amounts,
    dates,
    bestGuess: {
      numero: numeroRaw ? numeroRaw.toUpperCase() : (codes[0] || ''),
      descripcion: guessDescripcion(text),
      monto: subtotalRaw ? normalizeAmount(subtotalRaw) : null,
      montoIva: totalRaw ? normalizeAmount(totalRaw) : (amounts[0] ? amounts[0].value : null),
      fecha: dates[dates.length - 1] || '',
    },
  };
}
