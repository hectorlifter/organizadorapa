// Pantallas de impuestos y gastos: el modal para cargar conceptos, las retenciones de la orden
// de pago, la celda "Aparta / Libre" de cada trabajo y el panel de resumen del mes o del año.
// El cálculo está en impuestos.js; esto solo arma la pantalla y habla con Supabase.
import {
  TIPOS_RETENCION,
  calcularCobro,
  estaVigente,
  leerNumero,
  resumenDelAnio,
  resumenDelMes,
} from './impuestos.js';

const TIPOS = {
  porcentaje: 'Porcentaje sobre cada cobro',
  mensual: 'Gasto fijo por mes',
  anual: 'Gasto fijo por año',
};

const RETENCION_ASOCIADA = [
  { clave: '', nombre: 'Ninguna' },
  ...TIPOS_RETENCION.filter((t) => t.clave !== 'iva'),
];

// Ideas para arrancar: solo el nombre, el importe lo pones tú (o tu contador).
const SUGERIDOS = [
  { nombre: 'Ingresos brutos', tipo: 'porcentaje', retencion_tipo: 'iibb' },
  { nombre: 'Tasa municipal de seguridad e higiene', tipo: 'porcentaje' },
  { nombre: 'Impuesto a los créditos y débitos', tipo: 'porcentaje' },
  { nombre: 'Ganancias (provisión)', tipo: 'porcentaje', retencion_tipo: 'ganancias' },
  { nombre: 'Contador', tipo: 'mensual' },
  { nombre: 'Seguro', tipo: 'anual' },
];

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function crearImpuestosUI({ supabase, panel, toast, abrirModal, cerrarModal, fieldGroup, crearBoton, fmtMonto, fmtFecha, hoyISO, escapeHtml, obtenerJobs, alCambiar }) {
  let items = [];
  let errorCarga = null;
  let vista = 'mes';
  let mes = hoyISO().slice(0, 7);
  let anio = hoyISO().slice(0, 4);

  const num = (n) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(n);
  const nombreMes = (m) => `${MESES[Number(m.slice(5, 7)) - 1]} de ${m.slice(0, 4)}`;

  async function cargar() {
    const { data, error } = await supabase.from('impuestos_items').select('*').order('creado_en');
    if (error) {
      items = [];
      errorCarga = error.message;
      return;
    }
    errorCarga = null;
    items = data.map((i) => ({ ...i, valor: Number(i.valor) }));
  }

  const obtenerItems = () => items;

  // ---------- celda de cada trabajo ----------

  function celdaApartar(job) {
    if (!job.factura) return '<span class="muted">—</span>';
    const c = calcularCobro(job, items, job.pago?.fecha);
    if (!c) return '<span class="muted">—</span>';
    const detalle = c.lineas.map((l) => `${l.nombre}: aparta ${fmtMonto(l.aApartar)}${l.retenido ? ` (te retuvieron ${fmtMonto(l.retenido)})` : ''}`).join('\n');
    let html = `<div class="aparta" title="${escapeHtml(detalle)}"><div class="aparta-linea">Aparta <strong>${fmtMonto(c.aApartar)}</strong></div><div class="aparta-linea libre">Libre <strong>${fmtMonto(c.libre)}</strong></div></div>`;
    if (c.estimado) html += '<div class="hint">estimado, sin retenciones</div>';
    for (const s of c.saldoAFavor) {
      html += `<div class="hint">${s.sinImpuesto ? `Retención de ${escapeHtml(s.nombre)} sin impuesto cargado` : `Saldo a favor de ${escapeHtml(s.nombre)}`}: ${fmtMonto(s.monto)}</div>`;
    }
    return html;
  }

  // ---------- retenciones en la orden de pago ----------

  function camposRetenciones(inicial = {}) {
    const cont = document.createElement('div');
    cont.className = 'retenciones';
    const titulo = document.createElement('div');
    titulo.className = 'retenciones-titulo';
    titulo.textContent = 'Retenciones que te hicieron en este pago (opcional)';
    const ayuda = document.createElement('div');
    ayuda.className = 'hint';
    ayuda.textContent = 'Figuran en la orden de pago o en el aviso del cliente. Si no las sabes, déjalas vacías.';
    cont.append(titulo, ayuda);
    const inputs = {};
    for (const { clave, nombre } of TIPOS_RETENCION) {
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.placeholder = '0,00';
      if (inicial[clave]) input.value = String(inicial[clave]).replace('.', ',');
      inputs[clave] = input;
      cont.appendChild(fieldGroup(`Retención de ${nombre}`, input));
    }
    return {
      elemento: cont,
      // Devuelve solo las que tienen importe; si algo no es un número, avisa en vez de ignorarlo.
      leer() {
        const retenciones = {};
        for (const { clave, nombre } of TIPOS_RETENCION) {
          const texto = inputs[clave].value.trim();
          if (!texto) continue;
          const n = leerNumero(texto, { esImporte: true });
          if (n === null || n < 0) throw new Error(`Revisa el importe de la retención de ${nombre}.`);
          if (n > 0) retenciones[clave] = n;
        }
        return retenciones;
      },
    };
  }

  // ---------- modal: conceptos ----------

  function describir(item) {
    if (item.tipo === 'porcentaje') {
      const base = item.base === 'con_iva' ? 'el total con IVA' : 'el total sin IVA';
      return `${num(item.valor)} % sobre ${base}`;
    }
    if (item.tipo === 'mensual') return `${fmtMonto(item.valor)} por mes`;
    return `${fmtMonto(item.valor)} por año (${fmtMonto(item.valor / 12)} por mes)`;
  }

  function vigenciaTexto(item) {
    const desde = item.vigente_desde ? `desde ${fmtFecha(item.vigente_desde)}` : '';
    const hasta = item.vigente_hasta ? `, hasta ${fmtFecha(item.vigente_hasta)}` : '';
    return desde + hasta;
  }

  function abrirModalConceptos() {
    const raiz = document.createElement('div');
    raiz.className = 'conceptos';
    abrirModal('Impuestos y gastos', raiz);
    pintarLista(raiz);
  }

  function pintarLista(raiz) {
    raiz.innerHTML = '';
    const hoy = hoyISO();

    const intro = document.createElement('p');
    intro.className = 'hint';
    intro.textContent =
      'Carga aquí lo que sale de cada cobro y lo que pagas por mes o por año. El IVA (21 %) se aparta solo. Los importes los defines tú o tu contador: si una alícuota cambia, agrega la nueva y termina la vieja, así los cobros anteriores no se recalculan.';
    raiz.appendChild(intro);

    if (errorCarga) {
      const aviso = document.createElement('div');
      aviso.className = 'extract-status warn';
      aviso.textContent = `No pude cargar los conceptos: ${errorCarga}`;
      raiz.appendChild(aviso);
    }

    const grupos = [
      ['porcentaje', 'Porcentajes sobre cada cobro'],
      ['mensual', 'Gastos fijos por mes'],
      ['anual', 'Gastos fijos por año'],
    ];
    for (const [tipo, titulo] of grupos) {
      const delTipo = items.filter((i) => i.tipo === tipo);
      if (!delTipo.length) continue;
      const h = document.createElement('h3');
      h.className = 'conceptos-titulo';
      h.textContent = titulo;
      raiz.appendChild(h);
      for (const item of delTipo) raiz.appendChild(filaConcepto(item, hoy, raiz));
    }

    if (!items.length) {
      const vacio = document.createElement('p');
      vacio.className = 'muted';
      vacio.textContent = 'Todavía no cargaste nada. Puedes empezar con una de estas ideas (después completas el importe):';
      raiz.appendChild(vacio);
      const chips = document.createElement('div');
      chips.className = 'candidatos';
      for (const s of SUGERIDOS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'candidato-chip';
        b.textContent = s.nombre;
        b.addEventListener('click', () => pintarFormulario(raiz, null, s));
        chips.appendChild(b);
      }
      raiz.appendChild(chips);
    }

    const acciones = document.createElement('div');
    acciones.className = 'form-actions';
    acciones.append(crearBoton('Cerrar', 'btn-outline', cerrarModal), crearBoton('+ Agregar', 'btn-primary', () => pintarFormulario(raiz, null, null)));
    raiz.appendChild(acciones);
  }

  function filaConcepto(item, hoy, raiz) {
    const fila = document.createElement('div');
    const terminado = Boolean(item.vigente_hasta) && item.vigente_hasta < hoy;
    const futuro = item.vigente_desde > hoy;
    fila.className = 'concepto' + (terminado ? ' terminado' : '');
    const retencion = RETENCION_ASOCIADA.find((r) => r.clave && r.clave === item.retencion_tipo);
    const estado = terminado ? ' · terminado' : futuro ? ' · todavía no rige' : '';
    fila.innerHTML = `<div class="concepto-datos"><strong>${escapeHtml(item.nombre)}</strong><div>${escapeHtml(describir(item))}</div><div class="hint">${escapeHtml(vigenciaTexto(item))}${estado}${retencion ? ` · se compensa con la retención de ${escapeHtml(retencion.nombre)}` : ''}${item.notas ? ` · ${escapeHtml(item.notas)}` : ''}</div></div>`;
    const botones = document.createElement('div');
    botones.className = 'concepto-botones';
    botones.appendChild(crearBoton('Editar', 'btn-outline btn-small', () => pintarFormulario(raiz, item, null)));
    if (!terminado) {
      botones.appendChild(
        crearBoton('Terminar hoy', 'btn-outline btn-small', async () => {
          if (!window.confirm(`¿Terminar "${item.nombre}" hoy? Los cobros anteriores no cambian.`)) return;
          await guardar(raiz, item.id, { vigente_hasta: hoyISO() < item.vigente_desde ? item.vigente_desde : hoyISO() });
        }),
      );
    }
    botones.appendChild(
      crearBoton('Eliminar', 'btn-danger btn-small', async () => {
        if (!window.confirm(`¿Eliminar "${item.nombre}"? Si solo cambió el valor, mejor usa "Terminar hoy" y agrega el nuevo: así no se recalculan los cobros anteriores.`)) return;
        const { error } = await supabase.from('impuestos_items').delete().eq('id', item.id);
        if (error) return toast(error.message, true);
        await recargar(raiz, 'Concepto eliminado');
      }),
    );
    fila.appendChild(botones);
    return fila;
  }

  async function recargar(raiz, mensaje) {
    await cargar();
    toast(mensaje);
    if (raiz) pintarLista(raiz);
    alCambiar();
  }

  async function guardar(raiz, id, campos) {
    const consulta = id ? supabase.from('impuestos_items').update(campos).eq('id', id) : supabase.from('impuestos_items').insert(campos);
    const { error } = await consulta;
    if (error) return toast(error.message, true);
    await recargar(raiz, 'Guardado');
  }

  function pintarFormulario(raiz, item, sugerido) {
    raiz.innerHTML = '';
    const base = item ?? sugerido ?? {};
    const form = document.createElement('form');

    const nombre = document.createElement('input');
    nombre.type = 'text';
    nombre.required = true;
    nombre.value = base.nombre ?? '';
    nombre.placeholder = 'ej. Ingresos brutos';

    const tipo = document.createElement('select');
    for (const [clave, texto] of Object.entries(TIPOS)) tipo.add(new Option(texto, clave));
    tipo.value = base.tipo ?? 'porcentaje';

    const valor = document.createElement('input');
    valor.type = 'text';
    valor.inputMode = 'decimal';
    valor.required = true;
    valor.value = item ? String(item.valor).replace('.', ',') : '';

    const baseCalculo = document.createElement('select');
    baseCalculo.add(new Option('Sobre el total sin IVA (lo habitual)', 'sin_iva'));
    baseCalculo.add(new Option('Sobre el total con IVA', 'con_iva'));
    baseCalculo.value = item?.base ?? 'sin_iva';

    const retencion = document.createElement('select');
    for (const r of RETENCION_ASOCIADA) retencion.add(new Option(r.nombre, r.clave));
    retencion.value = base.retencion_tipo ?? '';

    const desde = document.createElement('input');
    desde.type = 'date';
    desde.required = true;
    desde.value = item?.vigente_desde ?? hoyISO();

    const hasta = document.createElement('input');
    hasta.type = 'date';
    hasta.value = item?.vigente_hasta ?? '';

    const notas = document.createElement('input');
    notas.type = 'text';
    notas.value = item?.notas ?? '';
    notas.placeholder = 'ej. alícuota de la actividad, según mi contador';

    const grupoValor = fieldGroup('Porcentaje (%)', valor);
    const etiquetaValor = grupoValor.querySelector('label');
    const grupoBase = fieldGroup('Se calcula', baseCalculo);
    const grupoRetencion = fieldGroup('Se compensa con la retención de', retencion, 'Si el cliente te retiene este impuesto, lo que te retuvo se descuenta de lo que hay que apartar.');

    const ajustar = () => {
      const esPorcentaje = tipo.value === 'porcentaje';
      etiquetaValor.textContent = esPorcentaje ? 'Porcentaje (%)' : tipo.value === 'mensual' ? 'Importe por mes ($)' : 'Importe por año ($)';
      grupoBase.classList.toggle('hidden', !esPorcentaje);
      grupoRetencion.classList.toggle('hidden', !esPorcentaje);
    };
    tipo.addEventListener('change', ajustar);
    ajustar();

    form.append(
      fieldGroup('Nombre', nombre),
      fieldGroup('Tipo', tipo),
      grupoValor,
      grupoBase,
      grupoRetencion,
      fieldGroup('Rige desde', desde),
      fieldGroup('Hasta (opcional)', hasta, 'Déjalo vacío si sigue vigente.'),
      fieldGroup('Nota (opcional)', notas),
    );

    const acciones = document.createElement('div');
    acciones.className = 'form-actions';
    const guardarBtn = document.createElement('button');
    guardarBtn.type = 'submit';
    guardarBtn.className = 'btn btn-primary';
    guardarBtn.textContent = item ? 'Guardar cambios' : 'Agregar';
    acciones.append(crearBoton('Volver', 'btn-outline', () => pintarLista(raiz)), guardarBtn);
    form.appendChild(acciones);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const importe = leerNumero(valor.value, { esImporte: tipo.value !== 'porcentaje' });
      if (importe === null || importe < 0) return toast('Revisa el importe: tiene que ser un número.', true);
      if (tipo.value === 'porcentaje' && importe > 100) return toast('Un porcentaje no puede pasar de 100.', true);
      if (hasta.value && hasta.value < desde.value) return toast('"Hasta" no puede ser anterior a "Rige desde".', true);
      const esPorcentaje = tipo.value === 'porcentaje';
      await guardar(raiz, item?.id ?? null, {
        nombre: nombre.value.trim(),
        tipo: tipo.value,
        valor: importe,
        base: esPorcentaje ? baseCalculo.value : 'sin_iva',
        retencion_tipo: esPorcentaje && retencion.value ? retencion.value : null,
        vigente_desde: desde.value,
        vigente_hasta: hasta.value || null,
        notas: notas.value.trim() || null,
      });
    });

    raiz.appendChild(form);
  }

  // ---------- panel de resumen ----------

  function alternarResumen() {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) renderResumen();
  }

  function tarjeta(titulo, monto, clase = '') {
    return `<div class="tarjeta ${clase}"><div class="tarjeta-titulo">${titulo}</div><div class="tarjeta-monto">${fmtMonto(monto)}</div></div>`;
  }

  function renderResumen() {
    if (panel.classList.contains('hidden')) return;
    const jobs = obtenerJobs();
    const r = vista === 'mes' ? resumenDelMes(jobs, items, mes) : resumenDelAnio(jobs, items, anio);
    const periodo = vista === 'mes' ? nombreMes(mes).replace(/^./, (c) => c.toUpperCase()) : anio;

    let html = `<div class="resumen-cabecera"><h2>Resumen de ${escapeHtml(periodo)}</h2><div class="resumen-controles">
      <select id="resumen-vista"><option value="mes"${vista === 'mes' ? ' selected' : ''}>Por mes</option><option value="anio"${vista === 'anio' ? ' selected' : ''}>Por año</option></select>
      ${vista === 'mes' ? `<input type="month" id="resumen-mes" value="${mes}">` : `<input type="number" id="resumen-anio" value="${anio}" min="2020" max="2100">`}
    </div></div>`;

    if (errorCarga) html += `<div class="extract-status warn">No pude cargar los impuestos y gastos: ${escapeHtml(errorCarga)}</div>`;
    else if (!items.length) html += '<div class="hint">Todavía no cargaste impuestos ni gastos: por ahora solo se aparta el IVA. Usa «Impuestos y gastos» para agregarlos.</div>';

    html += `<div class="tarjetas">
      ${tarjeta('Cobrado (con IVA)', r.facturado)}
      ${tarjeta('Te retuvieron', r.retenido)}
      ${tarjeta('Entró a la cuenta', r.efectivo)}
      ${tarjeta('Apartar para impuestos', r.aApartar, 'aparta')}
      ${tarjeta(vista === 'mes' ? 'Gastos fijos del mes' : 'Gastos fijos del año', r.totalFijos, 'aparta')}
      ${tarjeta('Libre', r.libre, 'libre')}
    </div>`;

    if (vista === 'anio') {
      html += '<div class="resumen-tabla-wrap"><table class="resumen-tabla"><thead><tr><th>Mes</th><th class="num">Cobrado</th><th class="num">Aparta</th><th class="num">Fijos</th><th class="num">Libre</th></tr></thead><tbody>';
      for (const m of r.meses) {
        html += `<tr><td>${escapeHtml(MESES[Number(m.mes.slice(5, 7)) - 1])}</td><td class="num">${fmtMonto(m.efectivo)}</td><td class="num">${fmtMonto(m.aApartar)}</td><td class="num">${fmtMonto(m.totalFijos)}</td><td class="num">${fmtMonto(m.libre)}</td></tr>`;
      }
      html += '</tbody></table></div>';
    } else if (r.cobros.length) {
      html += '<div class="resumen-tabla-wrap"><table class="resumen-tabla"><thead><tr><th>Presupuesto</th><th>Pago</th><th class="num">Entró</th><th class="num">Aparta</th><th class="num">Libre</th></tr></thead><tbody>';
      for (const c of r.cobros) {
        html += `<tr><td>${escapeHtml(c.job.presupuesto.numero)}</td><td>${fmtFecha(c.job.pago.fecha)}</td><td class="num">${fmtMonto(c.efectivo)}</td><td class="num">${fmtMonto(c.aApartar)}</td><td class="num">${fmtMonto(c.libre)}</td></tr>`;
      }
      html += '</tbody></table></div>';
    } else {
      html += '<div class="hint">No hay cobros en este mes.</div>';
    }

    if (r.fijos.length) {
      html += `<div class="resumen-fijos"><strong>Gastos fijos</strong>${r.fijos.map((f) => `<div>${escapeHtml(f.nombre)}${f.tipo === 'anual' && f.anual ? ' (anual, en doce partes)' : ''}: ${fmtMonto(f.monto)}</div>`).join('')}</div>`;
    }
    html += `<div class="hint">Por cobrar hoy: ${fmtMonto(r.porCobrar)} con IVA (habría que apartar unos ${fmtMonto(r.porCobrarAApartar)}, sin contar retenciones).</div>`;
    html += '<div class="hint">Es una estimación para ordenarte, no reemplaza la liquidación de tu contador: el IVA se aparta entero porque no se descuenta el crédito fiscal de tus compras.</div>';

    panel.innerHTML = html;
    panel.querySelector('#resumen-vista').addEventListener('change', (e) => { vista = e.target.value; renderResumen(); });
    panel.querySelector('#resumen-mes')?.addEventListener('change', (e) => { if (e.target.value) { mes = e.target.value; renderResumen(); } });
    panel.querySelector('#resumen-anio')?.addEventListener('change', (e) => { if (/^\d{4}$/.test(e.target.value)) { anio = e.target.value; renderResumen(); } });
  }

  return { cargar, obtenerItems, celdaApartar, camposRetenciones, abrirModalConceptos, alternarResumen, renderResumen, estaVigente };
}
