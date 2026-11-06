// Cálculo de lo que hay que apartar de cada cobro y del mes (responsable inscripto).
// Funciones puras, sin red ni pantalla: se prueban con `node --test` (ver tests/).
//
// Idea: de cada cobro, el IVA de la factura y los porcentajes de impuestos propios (ingresos
// brutos, tasas, etc.) no son plata libre. Las retenciones que te hizo el cliente ya salieron del
// pago, así que descuentan lo que falta apartar del impuesto al que corresponden.
// Es una ESTIMACIÓN para ordenar los gastos: no reemplaza a la liquidación del contador.

export const IVA_RATE = 0.21;

// Lo que el cliente puede retenerte en la orden de pago.
export const TIPOS_RETENCION = [
  { clave: 'iva', nombre: 'IVA' },
  { clave: 'ganancias', nombre: 'Ganancias' },
  { clave: 'iibb', nombre: 'Ingresos brutos' },
  { clave: 'suss', nombre: 'Seguridad social (SUSS)' },
];

const redondear = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
// La fecha de hoy según el reloj local (no la UTC), como en el resto de la app.
function hoyLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const numero = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// "3,5" o "3.5" → 3.5. Vacío o inválido → null.
// Con `esImporte`, un punto seguido de tres cifras es separador de miles: "50.000" → 50000
// (para un porcentaje, "3.500" sigue siendo 3,5).
export function leerNumero(texto, { esImporte = false } = {}) {
  const limpio = String(texto ?? '').trim().replace(/\s/g, '');
  if (!limpio) return null;
  // Formato argentino (1.234,56) o simple (1234.56 / 1234,56).
  let normal = limpio;
  if (/,/.test(limpio)) normal = limpio.replace(/\./g, '').replace(',', '.');
  else if (esImporte && /^\d{1,3}(\.\d{3})+$/.test(limpio)) normal = limpio.replace(/\./g, '');
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

// ¿El concepto rige en la fecha? (vigente_desde ≤ fecha ≤ vigente_hasta; sin "hasta" = sin fin)
export function estaVigente(item, fechaISO) {
  if (!item || item.activo === false) return false;
  if (item.vigente_desde && fechaISO < item.vigente_desde) return false;
  if (item.vigente_hasta && fechaISO > item.vigente_hasta) return false;
  return true;
}

// ¿Rige en algún día del mes "AAAA-MM"?
export function estaVigenteEnMes(item, mes) {
  const inicio = `${mes}-01`;
  const fin = `${mes}-31`;
  if (!item || item.activo === false) return false;
  if (item.vigente_desde && item.vigente_desde > fin) return false;
  if (item.vigente_hasta && item.vigente_hasta < inicio) return false;
  return true;
}

// Total con IVA y sin IVA de un trabajo: la factura manda; si no hay, el presupuesto.
export function montosDelTrabajo(job) {
  const factura = numero(job?.factura?.monto);
  const presConIva = numero(job?.presupuesto?.montoIva);
  const presSinIva = numero(job?.presupuesto?.monto);
  let conIva = factura ?? presConIva ?? (presSinIva !== null ? redondear(presSinIva * (1 + IVA_RATE)) : null);
  if (conIva === null) return null;
  let sinIva = factura !== null ? redondear(factura / (1 + IVA_RATE)) : presSinIva ?? redondear(conIva / (1 + IVA_RATE));
  return { conIva: redondear(conIva), sinIva, iva: redondear(conIva - sinIva) };
}

// Retenciones anotadas en la orden de pago: { iva, ganancias, iibb, suss } (las que falten, 0).
export function retencionesDe(job) {
  const crudas = job?.pago?.retenciones ?? {};
  const retenciones = {};
  for (const { clave } of TIPOS_RETENCION) retenciones[clave] = Math.max(0, numero(crudas[clave]) ?? 0);
  const total = redondear(Object.values(retenciones).reduce((a, b) => a + b, 0));
  return { ...retenciones, total };
}

// Qué apartar de un cobro. `fecha` es el día del cobro (o hoy, si todavía no se cobró).
// Para un trabajo sin cobrar las retenciones se desconocen: el resultado es un estimado.
export function calcularCobro(job, items = [], fecha) {
  const montos = montosDelTrabajo(job);
  if (!montos) return null;
  const pagado = Boolean(job?.pago?.pagado);
  const ret = pagado ? retencionesDe(job) : { iva: 0, ganancias: 0, iibb: 0, suss: 0, total: 0 };
  const dia = fecha || job?.pago?.fecha || hoyLocal();

  // Cada impuesto: su monto a reservar y a qué retención corresponde.
  const impuestos = [{ nombre: `IVA (${Math.round(IVA_RATE * 100)} %)`, retencion: 'iva', reserva: montos.iva }];
  for (const item of items) {
    if (item.tipo !== 'porcentaje' || !estaVigente(item, dia)) continue;
    const base = item.base === 'con_iva' ? montos.conIva : montos.sinIva;
    impuestos.push({
      id: item.id,
      nombre: `${item.nombre} (${item.valor} %)`,
      retencion: item.retencion_tipo || null,
      reserva: redondear((base * Number(item.valor)) / 100),
    });
  }

  // Lo retenido de cada tipo se usa de a una línea por vez, sin pasarse de lo que se debe.
  const credito = { iva: ret.iva, ganancias: ret.ganancias, iibb: ret.iibb, suss: ret.suss };
  const lineas = impuestos.map((imp) => {
    const disponible = imp.retencion ? credito[imp.retencion] ?? 0 : 0;
    const usado = Math.min(disponible, imp.reserva);
    if (imp.retencion) credito[imp.retencion] = redondear(disponible - usado);
    return { ...imp, retenido: redondear(usado), aApartar: redondear(imp.reserva - usado) };
  });

  const aApartar = redondear(lineas.reduce((suma, l) => suma + l.aApartar, 0));
  const efectivo = redondear(montos.conIva - ret.total);
  // Retenciones que sobran (saldo a favor) o que no corresponden a ningún impuesto cargado.
  const saldoAFavor = TIPOS_RETENCION.map(({ clave, nombre }) => ({
    clave,
    nombre,
    monto: credito[clave],
    sinImpuesto: !impuestos.some((i) => i.retencion === clave),
  })).filter((s) => s.monto > 0);

  return {
    pagado,
    estimado: !pagado,
    conIva: montos.conIva,
    sinIva: montos.sinIva,
    iva: montos.iva,
    retenciones: ret,
    efectivo,
    lineas,
    aApartar,
    libre: redondear(efectivo - aApartar),
    saldoAFavor,
  };
}

// ¿La fecha cae en el mes "AAAA-MM"?
function delMes(fechaISO, mes) {
  return typeof fechaISO === 'string' && fechaISO.slice(0, 7) === mes;
}

// Resumen del mes "AAAA-MM": lo cobrado, lo que se aparta, los gastos fijos y lo que queda libre.
export function resumenDelMes(jobs = [], items = [], mes) {
  const cobros = [];
  let porCobrar = 0;
  let porCobrarAApartar = 0;
  const hoy = hoyLocal();
  for (const job of jobs) {
    if (job?.pago?.pagado && delMes(job.pago.fecha, mes)) {
      const c = calcularCobro(job, items, job.pago.fecha);
      if (c) cobros.push({ job, ...c });
    } else if (job?.factura?.fecha && !job?.pago?.pagado) {
      const c = calcularCobro(job, items, hoy);
      if (c) {
        porCobrar += c.conIva;
        porCobrarAApartar += c.aApartar;
      }
    }
  }

  const suma = (campo) => redondear(cobros.reduce((acc, c) => acc + c[campo], 0));
  const retenido = redondear(cobros.reduce((acc, c) => acc + c.retenciones.total, 0));

  const fijos = [];
  for (const item of items) {
    if (!estaVigenteEnMes(item, mes)) continue;
    if (item.tipo === 'mensual') fijos.push({ nombre: item.nombre, tipo: 'mensual', monto: redondear(Number(item.valor)) });
    if (item.tipo === 'anual') fijos.push({ nombre: item.nombre, tipo: 'anual', monto: redondear(Number(item.valor) / 12), anual: Number(item.valor) });
  }
  const totalFijos = redondear(fijos.reduce((acc, f) => acc + f.monto, 0));

  const efectivo = suma('efectivo');
  const aApartar = suma('aApartar');
  return {
    mes,
    cantidadCobros: cobros.length,
    facturado: suma('conIva'),
    retenido,
    efectivo,
    aApartar,
    fijos,
    totalFijos,
    libre: redondear(efectivo - aApartar - totalFijos),
    porCobrar: redondear(porCobrar),
    porCobrarAApartar: redondear(porCobrarAApartar),
    cobros,
  };
}

// Resumen de un año: los doce meses juntos (los gastos anuales suman sus doce partes).
export function resumenDelAnio(jobs = [], items = [], anio) {
  const meses = [];
  for (let m = 1; m <= 12; m += 1) meses.push(resumenDelMes(jobs, items, `${anio}-${String(m).padStart(2, '0')}`));
  const suma = (campo) => redondear(meses.reduce((acc, x) => acc + x[campo], 0));
  const fijos = new Map();
  for (const mes of meses) {
    for (const f of mes.fijos) fijos.set(f.nombre, { nombre: f.nombre, tipo: f.tipo, monto: redondear((fijos.get(f.nombre)?.monto ?? 0) + f.monto) });
  }
  return {
    anio,
    meses,
    cantidadCobros: meses.reduce((acc, x) => acc + x.cantidadCobros, 0),
    facturado: suma('facturado'),
    retenido: suma('retenido'),
    efectivo: suma('efectivo'),
    aApartar: suma('aApartar'),
    fijos: [...fijos.values()],
    totalFijos: suma('totalFijos'),
    libre: suma('libre'),
    porCobrar: meses[0].porCobrar,
    porCobrarAApartar: meses[0].porCobrarAApartar,
    cobros: meses.flatMap((x) => x.cobros),
  };
}
