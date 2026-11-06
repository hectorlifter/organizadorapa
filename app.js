import { extractText, guessCandidates } from './pdf-extract.js';
import { crearImpuestosUI } from './impuestos-ui.js';

const IVA_RATE = 0.21;
const BUCKET = 'pdfs';
const DOC_FILENAMES = {
  presupuesto: 'presupuesto.pdf',
  orden_compra: 'orden_compra.pdf',
  factura: 'factura.pdf',
  orden_pago: 'orden_pago.pdf',
};

const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

// ---------- autenticacion ----------

const pantallaLogin = document.getElementById('pantalla-login');
const appContenido = document.getElementById('app-contenido');
const formLogin = document.getElementById('form-login');
const loginError = document.getElementById('login-error');
const btnLogin = document.getElementById('btn-login');

formLogin.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');
  btnLogin.disabled = true;
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  btnLogin.disabled = false;
  if (error) {
    loginError.textContent = error.message === 'Invalid login credentials' ? 'Email o contraseña incorrectos.' : error.message;
    loginError.classList.remove('hidden');
  }
});

document.getElementById('btn-salir').addEventListener('click', () => supabaseClient.auth.signOut());

let intervaloIniciado = false;
supabaseClient.auth.onAuthStateChange((_event, session) => {
  if (session) {
    pantallaLogin.classList.add('hidden');
    appContenido.classList.remove('hidden');
    cargarTrabajos();
    if (!intervaloIniciado) {
      intervaloIniciado = true;
      setInterval(cargarTrabajos, 5 * 60 * 1000);
    }
  } else {
    appContenido.classList.add('hidden');
    pantallaLogin.classList.remove('hidden');
  }
});

// ---------- impuestos y gastos (impuestos-ui.js) ----------
// Las funciones de abajo se declaran con "function", así que ya existen cuando esto corre.
const impuestosUI = crearImpuestosUI({
  supabase: supabaseClient,
  panel: document.getElementById('panel-resumen'),
  toast,
  abrirModal,
  cerrarModal,
  fieldGroup,
  crearBoton,
  fmtMonto,
  fmtFecha,
  hoyISO,
  escapeHtml,
  obtenerJobs: () => jobs,
  alCambiar: () => { renderTabla(); impuestosUI.renderResumen(); },
});
document.getElementById('btn-impuestos').addEventListener('click', () => impuestosUI.abrirModalConceptos());
document.getElementById('btn-resumen').addEventListener('click', () => impuestosUI.alternarResumen());

// ---------- estado general de la pagina ----------

const tbody = document.getElementById('tbody-trabajos');
const overlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const toastEl = document.getElementById('toast');

let jobs = [];
let toastTimer = null;

function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3500);
}

function cerrarModal() {
  overlay.classList.add('hidden');
  modalBody.innerHTML = '';
}

function abrirModal(title, bodyEl) {
  modalTitle.textContent = title;
  modalBody.innerHTML = '';
  modalBody.appendChild(bodyEl);
  overlay.classList.remove('hidden');
}

document.getElementById('btn-cerrar-modal').addEventListener('click', cerrarModal);
overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrarModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarModal(); });

function conIva(monto) {
  return Math.round(monto * (1 + IVA_RATE) * 100) / 100;
}

function fmtMonto(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return '$ ' + new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function fmtFecha(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function fechaLocalISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function hoyISO() {
  return fechaLocalISO(new Date());
}

// ---------- calculo de estado (equivalente al que hacia el servidor) ----------

function diasEntre(fechaISO, hastaISO) {
  const desde = new Date(fechaISO + 'T00:00:00');
  const hasta = new Date((hastaISO || hoyISO()) + 'T00:00:00');
  return Math.max(0, Math.round((hasta - desde) / 86400000));
}

function conEstado(job) {
  let estado = 'sin_factura';
  let dias = null;
  let color = null;

  if (job.pago && job.pago.pagado) {
    estado = 'pagado';
    dias = job.factura ? diasEntre(job.factura.fecha, job.pago.fecha) : null;
  } else if (job.factura && job.factura.fecha) {
    estado = 'pendiente_cobro';
    dias = diasEntre(job.factura.fecha);
    color = dias <= 35 ? 'verde' : dias <= 45 ? 'amarillo' : 'rojo';
  } else if (job.ordenCompra) {
    estado = 'sin_factura';
  } else {
    estado = 'sin_orden_compra';
  }

  job.estado = estado;
  job.diasSinPagar = dias;
  job.colorEstado = color;
  return job;
}

// ---------- capa de datos: Supabase (tabla jobs + bucket pdfs) ----------

function filaAJob(row) {
  return { id: row.id, creadoEn: row.creado_en, ...row.data };
}

async function obtenerJobRow(id) {
  const { data, error } = await supabaseClient.from('jobs').select('*').eq('id', id).single();
  if (error) throw new Error(error.message);
  return data;
}

async function actualizarJobData(id, nuevaData) {
  const { error } = await supabaseClient.from('jobs').update({ data: nuevaData }).eq('id', id);
  if (error) throw new Error(error.message);
}

async function subirArchivo(jobId, nombreArchivo, file) {
  const path = `${jobId}/${nombreArchivo}`;
  const { error } = await supabaseClient.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: 'application/pdf' });
  if (error) throw new Error(error.message);
  return nombreArchivo;
}

async function borrarArchivo(jobId, nombreArchivo) {
  if (!nombreArchivo) return;
  await supabaseClient.storage.from(BUCKET).remove([`${jobId}/${nombreArchivo}`]);
}

async function verArchivo(jobId, nombreArchivo) {
  const { data, error } = await supabaseClient.storage.from(BUCKET).createSignedUrl(`${jobId}/${nombreArchivo}`, 60);
  if (error) { toast('No se pudo abrir el PDF: ' + error.message, true); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}

async function crearJob({ numeroPresupuesto, descripcion, monto, montoIva, file }) {
  if (!numeroPresupuesto || !String(numeroPresupuesto).trim()) throw new Error('Falta el numero de presupuesto');
  const id = crypto.randomUUID();
  const archivo = file ? await subirArchivo(id, DOC_FILENAMES.presupuesto, file) : null;

  const montoNum = monto === '' || monto === undefined || monto === null ? null : Number(monto);
  let montoIvaNum = montoIva === '' || montoIva === undefined || montoIva === null ? null : Number(montoIva);
  if (montoIvaNum === null && montoNum !== null) montoIvaNum = conIva(montoNum);

  const data = {
    presupuesto: {
      numero: String(numeroPresupuesto).trim(),
      descripcion: descripcion || '',
      monto: montoNum,
      montoIva: montoIvaNum,
      archivo,
    },
    ordenCompra: null,
    factura: null,
    pago: null,
  };

  const { error } = await supabaseClient.from('jobs').insert({ id, creado_en: new Date().toISOString(), data });
  if (error) throw new Error(error.message);
}

async function adjuntarOrdenCompra(job, { numeroOrdenCompra, file }) {
  if (!numeroOrdenCompra || !numeroOrdenCompra.trim()) throw new Error('Falta el numero de orden de compra');
  const row = await obtenerJobRow(job.id);
  let archivo = row.data.ordenCompra ? row.data.ordenCompra.archivo : null;
  if (file) archivo = await subirArchivo(job.id, DOC_FILENAMES.orden_compra, file);
  row.data.ordenCompra = { numero: numeroOrdenCompra.trim(), archivo };
  await actualizarJobData(job.id, row.data);
}

async function adjuntarFactura(job, { numeroFactura, fechaFactura, montoFactura, file }) {
  if (!numeroFactura || !numeroFactura.trim()) throw new Error('Falta el numero de factura');
  if (!fechaFactura || !/^\d{4}-\d{2}-\d{2}$/.test(fechaFactura)) throw new Error('Falta o es invalida la fecha de la factura');
  const row = await obtenerJobRow(job.id);
  let archivo = row.data.factura ? row.data.factura.archivo : null;
  if (file) archivo = await subirArchivo(job.id, DOC_FILENAMES.factura, file);
  row.data.factura = {
    numero: numeroFactura.trim(),
    fecha: fechaFactura,
    monto: montoFactura === '' || montoFactura === undefined || montoFactura === null ? null : Number(montoFactura),
    archivo,
  };
  row.data.pago = null; // si se vuelve a subir la factura, se pierde el pago previo (igual que antes)
  await actualizarJobData(job.id, row.data);
}

async function adjuntarOrdenPago(job, { fechaPago, file, retenciones }) {
  const row = await obtenerJobRow(job.id);
  const fecha = fechaPago && /^\d{4}-\d{2}-\d{2}$/.test(fechaPago) ? fechaPago : hoyISO();
  let archivo = row.data.pago ? row.data.pago.archivo : null;
  if (file) archivo = await subirArchivo(job.id, DOC_FILENAMES.orden_pago, file);
  row.data.pago = { pagado: true, fecha, archivo };
  if (retenciones && Object.keys(retenciones).length) row.data.pago.retenciones = retenciones;
  await actualizarJobData(job.id, row.data);
}

async function editarJob(job, patch) {
  const row = await obtenerJobRow(job.id);
  if (patch.presupuesto) row.data.presupuesto = { ...row.data.presupuesto, ...patch.presupuesto };
  if (patch.ordenCompra) row.data.ordenCompra = { ...row.data.ordenCompra, ...patch.ordenCompra };
  if (patch.factura) row.data.factura = { ...row.data.factura, ...patch.factura };
  if (patch.pago) row.data.pago = { ...row.data.pago, ...patch.pago };
  await actualizarJobData(job.id, row.data);
}

const DOC_INFO = {
  presupuesto: { mensaje: 'Eliminar el PDF del presupuesto? El numero, la descripcion y los montos se mantienen.' },
  'orden-compra': { mensaje: 'Eliminar la orden de compra de este trabajo? Vas a poder volver a subirla.' },
  factura: { mensaje: 'Eliminar la factura de este trabajo? Si estaba marcado como pagado, ese estado tambien se revierte.' },
  'orden-pago': { mensaje: 'Eliminar la orden de pago? El trabajo vuelve a pendiente de cobro.' },
};

async function eliminarDocumento(jobId, tipo) {
  const info = DOC_INFO[tipo];
  if (!info || !confirm(info.mensaje)) return;
  try {
    const row = await obtenerJobRow(jobId);
    if (tipo === 'presupuesto') {
      await borrarArchivo(jobId, row.data.presupuesto.archivo);
      row.data.presupuesto.archivo = null;
    } else if (tipo === 'orden-compra') {
      if (row.data.ordenCompra) await borrarArchivo(jobId, row.data.ordenCompra.archivo);
      row.data.ordenCompra = null;
    } else if (tipo === 'factura') {
      if (row.data.factura) await borrarArchivo(jobId, row.data.factura.archivo);
      if (row.data.pago) await borrarArchivo(jobId, row.data.pago.archivo);
      row.data.factura = null;
      row.data.pago = null;
    } else if (tipo === 'orden-pago') {
      if (row.data.pago) await borrarArchivo(jobId, row.data.pago.archivo);
      row.data.pago = null;
    }
    await actualizarJobData(jobId, row.data);
    toast('Documento eliminado');
    cargarTrabajos();
  } catch (err) {
    toast(err.message, true);
  }
}

tbody.addEventListener('click', (e) => {
  const adjBtn = e.target.closest('[data-adjuntar-oc]');
  if (adjBtn) { const j = jobs.find((x) => x.id === adjBtn.dataset.jobId); if (j) abrirModalOrdenCompra(j); return; }
  const verBtn = e.target.closest('[data-ver-doc]');
  if (verBtn) { verArchivo(verBtn.dataset.jobId, verBtn.dataset.verDoc); return; }
  const delBtn = e.target.closest('[data-eliminar-doc]');
  if (delBtn) eliminarDocumento(delBtn.dataset.jobId, delBtn.dataset.eliminarDoc);
});

async function eliminarTrabajo(job) {
  if (!confirm(`Eliminar el trabajo "${job.presupuesto.numero}" y todos sus documentos? Esta accion no se puede deshacer.`)) return;
  try {
    const { data: lista } = await supabaseClient.storage.from(BUCKET).list(job.id);
    if (lista && lista.length) {
      await supabaseClient.storage.from(BUCKET).remove(lista.map((f) => `${job.id}/${f.name}`));
    }
    const { error } = await supabaseClient.from('jobs').delete().eq('id', job.id);
    if (error) throw new Error(error.message);
    toast('Trabajo eliminado');
    cargarTrabajos();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- carga y render de la tabla ----------

async function cargarTrabajos() {
  try {
    const { data, error } = await supabaseClient.from('jobs').select('*');
    if (error) throw new Error(error.message);
    jobs = data
      .map(filaAJob)
      .map(conEstado)
      .sort((a, b) => a.presupuesto.numero.localeCompare(b.presupuesto.numero, undefined, { numeric: true }));
    // Los impuestos son un agregado: si fallan, los trabajos se ven igual.
    await impuestosUI.cargar().catch((err) => console.warn('No se pudieron cargar los impuestos:', err.message));
    renderTabla();
    impuestosUI.renderResumen();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="vacio">No se pudo cargar: ${err.message}</td></tr>`;
  }
}

function renderTabla() {
  if (!jobs.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="vacio">Todavia no cargaste ningun presupuesto. Empeza con "+ Nuevo presupuesto".</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const job of jobs) tbody.appendChild(filaTrabajo(job));
}

function docLink(jobId, archivo, etiqueta) {
  if (!archivo) return '';
  return `<button type="button" class="btn-link" data-ver-doc="${archivo}" data-job-id="${jobId}">${etiqueta}</button>`;
}

function eliminarDocLink(jobId, tipo) {
  return `<button type="button" class="btn-link btn-link-danger" data-eliminar-doc="${tipo}" data-job-id="${jobId}">Eliminar</button>`;
}

function badgeEstado(job) {
  if (job.estado === 'pagado') {
    const fecha = job.pago && job.pago.fecha ? fmtFecha(job.pago.fecha) : '';
    const ver = docLink(job.id, job.pago.archivo, 'Ver PDF');
    return `<span class="badge-estado pagado dot">Pagado</span><div class="hint">${fecha}</div><div>${ver}${ver ? ' · ' : ''}${eliminarDocLink(job.id, 'orden-pago')}</div>`;
  }
  if (job.estado === 'pendiente_cobro') {
    return `<span class="badge-estado ${job.colorEstado} dot">${job.diasSinPagar} dias sin cobrar</span>`;
  }
  if (job.estado === 'sin_factura') {
    return '<span class="muted">Falta factura</span>';
  }
  return '<span class="muted">Falta orden de compra</span>';
}

function filaTrabajo(job) {
  const tr = document.createElement('tr');

  const tdPresupuesto = document.createElement('td');
  tdPresupuesto.className = 'c-pres';
  const verPresupuesto = docLink(job.id, job.presupuesto.archivo, 'Ver PDF');
  tdPresupuesto.innerHTML = `<strong>${escapeHtml(job.presupuesto.numero)}</strong><div>${verPresupuesto}${job.presupuesto.archivo ? ' · ' + eliminarDocLink(job.id, 'presupuesto') : ''}</div>`;

  const tdDesc = document.createElement('td');
  tdDesc.className = 'desc-cell c-desc';
  tdDesc.title = job.presupuesto.descripcion || '';
  tdDesc.textContent = job.presupuesto.descripcion || '—';
  tdDesc.addEventListener('click', () => tdDesc.classList.toggle('abierta'));

  const tdOC = document.createElement('td');
  tdOC.className = 'c-oc';
  tdOC.dataset.label = 'Orden de compra';
  tdOC.innerHTML = job.ordenCompra
    ? `${escapeHtml(job.ordenCompra.numero)}<div>${job.ordenCompra.archivo ? docLink(job.id, job.ordenCompra.archivo, 'Ver PDF') : `<button type="button" class="btn-link" data-adjuntar-oc="1" data-job-id="${job.id}">Adjuntar PDF</button>`} · ${eliminarDocLink(job.id, 'orden-compra')}</div>`
    : '<span class="muted">—</span>';

  const tdMonto = document.createElement('td');
  tdMonto.className = 'num c-monto';
  tdMonto.dataset.label = 'Monto';
  tdMonto.textContent = fmtMonto(job.presupuesto.monto);

  const tdMontoIva = document.createElement('td');
  tdMontoIva.className = 'num c-iva';
  tdMontoIva.dataset.label = 'Monto c/IVA';
  const montoIvaMostrado = (job.factura && job.factura.monto !== null && job.factura.monto !== undefined)
    ? job.factura.monto
    : job.presupuesto.montoIva;
  tdMontoIva.textContent = fmtMonto(montoIvaMostrado);

  const tdFactura = document.createElement('td');
  tdFactura.className = 'c-fact';
  tdFactura.dataset.label = 'Factura';
  tdFactura.innerHTML = job.factura
    ? `<strong>${escapeHtml(job.factura.numero || '—')}</strong><div class="hint">${fmtFecha(job.factura.fecha)}</div><div>${docLink(job.id, job.factura.archivo, 'Ver PDF')}${job.factura.archivo ? ' · ' : ''}${eliminarDocLink(job.id, 'factura')}</div>`
    : '<span class="muted">—</span>';

  const tdEstado = document.createElement('td');
  tdEstado.className = 'c-estado';
  tdEstado.innerHTML = badgeEstado(job);

  const tdAparta = document.createElement('td');
  tdAparta.className = 'c-aparta';
  tdAparta.dataset.label = 'Aparta / libre';
  tdAparta.innerHTML = impuestosUI.celdaApartar(job);

  const tdAcciones = document.createElement('td');
  tdAcciones.className = 'acciones c-acc';
  tdAcciones.appendChild(botonesAccion(job));

  tr.append(tdPresupuesto, tdDesc, tdOC, tdMonto, tdMontoIva, tdFactura, tdEstado, tdAparta, tdAcciones);
  return tr;
}

function botonesAccion(job) {
  const wrap = document.createElement('div');
  wrap.className = 'acciones';

  if (!job.ordenCompra) {
    wrap.appendChild(crearBoton('Cargar OC', 'btn-outline', () => abrirModalOrdenCompra(job)));
  } else if (!job.factura) {
    wrap.appendChild(crearBoton('Subir factura', 'btn-outline', () => abrirModalFactura(job)));
  } else if (job.estado !== 'pagado') {
    wrap.appendChild(crearBoton('Subir orden de pago', 'btn-primary', () => abrirModalOrdenPago(job)));
  }

  wrap.appendChild(crearBoton('Editar', 'btn-outline btn-small', () => abrirModalEditar(job)));
  wrap.appendChild(crearBoton('Eliminar', 'btn-danger btn-small', () => eliminarTrabajo(job)));
  return wrap;
}

function crearBoton(texto, clases, onClick) {
  const b = document.createElement('button');
  b.textContent = texto;
  b.className = 'btn ' + clases;
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- extraccion de PDF: corre en el propio navegador ----------

async function extraer(tipo, file) {
  const texto = await extractText(file);
  const candidates = guessCandidates(texto, tipo);
  return { textoVacio: !texto || !texto.trim(), candidates };
}

function fieldGroup(labelText, inputEl, hintText) {
  const div = document.createElement('div');
  div.className = 'field';
  const label = document.createElement('label');
  label.textContent = labelText;
  div.appendChild(label);
  div.appendChild(inputEl);
  if (hintText) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = hintText;
    div.appendChild(hint);
  }
  return div;
}

function contenedorCandidatos() {
  const div = document.createElement('div');
  div.className = 'candidatos';
  return div;
}

function chip(texto, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'candidato-chip';
  b.textContent = texto;
  b.addEventListener('click', onClick);
  return b;
}

function pintarCandidatosCodigo(container, codes, targetInput) {
  container.innerHTML = '';
  codes.slice(0, 10).forEach((c) => container.appendChild(chip(c, () => { targetInput.value = c; })));
}

function pintarCandidatosFecha(container, dates, targetInput) {
  container.innerHTML = '';
  dates.slice(0, 10).forEach((d) => container.appendChild(chip(fmtFecha(d), () => { targetInput.value = d; })));
}

function pintarCandidatosMonto(container, amounts, camposObjetivo, ultimoEnfocado) {
  container.innerHTML = '';
  amounts.slice(0, 10).forEach((a) => {
    container.appendChild(chip(fmtMonto(a.value), () => {
      const destino = ultimoEnfocado.el || camposObjetivo[0];
      destino.value = a.value;
      destino.dispatchEvent(new Event('input'));
    }));
  });
}

function status(msg, cls) {
  const div = document.createElement('div');
  div.className = 'extract-status' + (cls ? ' ' + cls : '');
  div.textContent = msg;
  return div;
}

// ---------- modal: nuevo presupuesto ----------

function abrirModalNuevo() {
  const form = document.createElement('form');
  let archivoElegido = null;

  const inputFile = document.createElement('input');
  inputFile.type = 'file';
  inputFile.accept = 'application/pdf';
  inputFile.required = true;

  const inputNumero = document.createElement('input');
  inputNumero.type = 'text';
  inputNumero.placeholder = 'ej. 0001-2026';
  inputNumero.required = true;

  const inputDesc = document.createElement('textarea');
  inputDesc.placeholder = 'Descripcion del trabajo';

  const inputMonto = document.createElement('input');
  inputMonto.type = 'number';
  inputMonto.step = '0.01';
  inputMonto.placeholder = '0.00';

  const inputMontoIva = document.createElement('input');
  inputMontoIva.type = 'number';
  inputMontoIva.step = '0.01';
  inputMontoIva.placeholder = '0.00';

  inputMonto.addEventListener('input', () => {
    const m = parseFloat(inputMonto.value);
    if (Number.isFinite(m) && m > 0) inputMontoIva.value = conIva(m);
  });

  const ultimoEnfocado = { el: inputMontoIva };
  inputMonto.addEventListener('focus', () => { ultimoEnfocado.el = inputMonto; });
  inputMontoIva.addEventListener('focus', () => { ultimoEnfocado.el = inputMontoIva; });

  const estadoExtraccion = status('Elegi el PDF del presupuesto para detectar los datos automaticamente.');
  const candCodigo = contenedorCandidatos();
  const candMonto = contenedorCandidatos();

  form.appendChild(fieldGroup('Documento PDF del presupuesto', inputFile));
  form.appendChild(estadoExtraccion);
  form.appendChild(fieldGroup('Numero de presupuesto', inputNumero));
  form.appendChild(candCodigo);
  form.appendChild(fieldGroup('Descripcion del trabajo', inputDesc));
  form.appendChild(fieldGroup('Monto (sin IVA)', inputMonto, 'El monto con IVA se calcula solo (21%); lo podes corregir si hace falta.'));
  form.appendChild(fieldGroup('Monto con IVA', inputMontoIva));
  form.appendChild(candMonto);

  inputFile.addEventListener('change', async () => {
    const file = inputFile.files[0];
    if (!file) return;
    archivoElegido = file;
    estadoExtraccion.textContent = 'Leyendo PDF...';
    estadoExtraccion.className = 'extract-status';
    try {
      const res = await extraer('presupuesto', file);
      const c = res.candidates;
      if (res.textoVacio) {
        estadoExtraccion.textContent = 'El PDF no tiene texto seleccionable (puede ser un escaneo). Completa los datos a mano.';
        estadoExtraccion.className = 'extract-status warn';
      } else {
        estadoExtraccion.textContent = 'Datos detectados, revisalos antes de guardar.';
        estadoExtraccion.className = 'extract-status ok';
      }
      if (c.bestGuess.numero) inputNumero.value = c.bestGuess.numero;
      if (c.bestGuess.descripcion) inputDesc.value = c.bestGuess.descripcion;
      if (c.bestGuess.monto !== null) {
        inputMonto.value = c.bestGuess.monto;
        inputMonto.dispatchEvent(new Event('input'));
      }
      if (c.bestGuess.montoIva !== null) inputMontoIva.value = c.bestGuess.montoIva;
      pintarCandidatosCodigo(candCodigo, c.codes, inputNumero);
      pintarCandidatosMonto(candMonto, c.amounts, [inputMonto, inputMontoIva], ultimoEnfocado);
    } catch (err) {
      estadoExtraccion.textContent = 'No se pudo leer el PDF: ' + err.message;
      estadoExtraccion.className = 'extract-status warn';
    }
  });

  const acciones = document.createElement('div');
  acciones.className = 'form-actions';
  const btnCancelar = crearBoton('Cancelar', 'btn-outline', cerrarModal);
  const btnGuardar = document.createElement('button');
  btnGuardar.type = 'submit';
  btnGuardar.className = 'btn btn-primary';
  btnGuardar.textContent = 'Crear trabajo';
  acciones.append(btnCancelar, btnGuardar);
  form.appendChild(acciones);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!archivoElegido) { toast('Elegi un PDF', true); return; }
    btnGuardar.disabled = true;
    try {
      await crearJob({
        numeroPresupuesto: inputNumero.value,
        descripcion: inputDesc.value,
        monto: inputMonto.value,
        montoIva: inputMontoIva.value,
        file: archivoElegido,
      });
      toast('Trabajo creado');
      cerrarModal();
      cargarTrabajos();
    } catch (err) {
      toast(err.message, true);
      btnGuardar.disabled = false;
    }
  });

  abrirModal('Nuevo presupuesto', form);
  inputFile.focus();
}

// ---------- modal: orden de compra ----------

function abrirModalOrdenCompra(job) {
  const form = document.createElement('form');
  let archivoElegido = null;

  const inputFile = document.createElement('input');
  inputFile.type = 'file';
  inputFile.accept = 'application/pdf';

  const inputNumero = document.createElement('input');
  inputNumero.type = 'text';
  inputNumero.placeholder = 'ej. 123456-000-OP';
  inputNumero.required = true;
  if (job.ordenCompra) inputNumero.value = job.ordenCompra.numero;

  const estadoExtraccion = status(`Presupuesto ${job.presupuesto.numero}. Escribi solo el numero, o subi el PDF y se lee solo.`);
  const candCodigo = contenedorCandidatos();

  form.appendChild(fieldGroup('Documento PDF de la orden de compra (opcional)', inputFile));
  form.appendChild(estadoExtraccion);
  form.appendChild(fieldGroup('Numero de orden de compra', inputNumero));
  form.appendChild(candCodigo);

  inputFile.addEventListener('change', async () => {
    const file = inputFile.files[0];
    if (!file) return;
    archivoElegido = file;
    estadoExtraccion.textContent = 'Leyendo PDF...';
    try {
      const res = await extraer('orden_compra', file);
      const c = res.candidates;
      estadoExtraccion.textContent = res.textoVacio
        ? 'El PDF no tiene texto seleccionable. Completa el numero a mano.'
        : 'Datos detectados, revisalos antes de guardar.';
      estadoExtraccion.className = 'extract-status ' + (res.textoVacio ? 'warn' : 'ok');
      if (c.bestGuess.numero) inputNumero.value = c.bestGuess.numero;
      pintarCandidatosCodigo(candCodigo, c.codes, inputNumero);
    } catch (err) {
      estadoExtraccion.textContent = 'No se pudo leer el PDF: ' + err.message;
      estadoExtraccion.className = 'extract-status warn';
    }
  });

  const acciones = document.createElement('div');
  acciones.className = 'form-actions';
  acciones.append(
    crearBoton('Cancelar', 'btn-outline', cerrarModal),
    (() => {
      const b = document.createElement('button');
      b.type = 'submit';
      b.className = 'btn btn-primary';
      b.textContent = 'Guardar orden de compra';
      return b;
    })()
  );
  form.appendChild(acciones);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await adjuntarOrdenCompra(job, { numeroOrdenCompra: inputNumero.value, file: archivoElegido });
      toast('Orden de compra guardada');
      cerrarModal();
      cargarTrabajos();
    } catch (err) {
      toast(err.message, true);
    }
  });

  abrirModal(job.ordenCompra ? 'Orden de compra' : 'Cargar orden de compra', form);
}

// ---------- modal: factura ----------

function abrirModalFactura(job) {
  const form = document.createElement('form');
  let archivoElegido = null;

  const inputFile = document.createElement('input');
  inputFile.type = 'file';
  inputFile.accept = 'application/pdf';
  inputFile.required = true;

  const inputNumero = document.createElement('input');
  inputNumero.type = 'text';
  inputNumero.placeholder = 'ej. A-0001-00003321';
  inputNumero.required = true;

  const inputFecha = document.createElement('input');
  inputFecha.type = 'date';
  inputFecha.required = true;
  inputFecha.max = hoyISO();

  const inputMonto = document.createElement('input');
  inputMonto.type = 'number';
  inputMonto.step = '0.01';
  inputMonto.placeholder = '0.00';

  const estadoExtraccion = status(`Presupuesto ${job.presupuesto.numero}. Eleji el PDF de la factura.`);
  const candCodigo = contenedorCandidatos();
  const candFecha = contenedorCandidatos();
  const candMonto = contenedorCandidatos();

  form.appendChild(fieldGroup('Documento PDF de la factura', inputFile));
  form.appendChild(estadoExtraccion);
  form.appendChild(fieldGroup('Numero de factura', inputNumero));
  form.appendChild(candCodigo);
  form.appendChild(fieldGroup('Fecha en que se realizo el trabajo / fecha de factura', inputFecha));
  form.appendChild(candFecha);
  form.appendChild(fieldGroup('Monto confirmado con IVA', inputMonto, 'Desde esta fecha se cuentan los dias sin cobrar.'));
  form.appendChild(candMonto);

  inputFile.addEventListener('change', async () => {
    const file = inputFile.files[0];
    if (!file) return;
    archivoElegido = file;
    estadoExtraccion.textContent = 'Leyendo PDF...';
    try {
      const res = await extraer('factura', file);
      const c = res.candidates;
      estadoExtraccion.textContent = res.textoVacio
        ? 'El PDF no tiene texto seleccionable. Completa los datos a mano.'
        : 'Datos detectados, revisalos antes de guardar.';
      estadoExtraccion.className = 'extract-status ' + (res.textoVacio ? 'warn' : 'ok');
      if (c.bestGuess.numero) inputNumero.value = c.bestGuess.numero;
      if (c.bestGuess.fecha) inputFecha.value = c.bestGuess.fecha;
      if (c.bestGuess.montoIva !== null) inputMonto.value = c.bestGuess.montoIva;
      pintarCandidatosCodigo(candCodigo, c.codes, inputNumero);
      pintarCandidatosFecha(candFecha, c.dates, inputFecha);
      pintarCandidatosMonto(candMonto, c.amounts, [inputMonto], { el: inputMonto });
    } catch (err) {
      estadoExtraccion.textContent = 'No se pudo leer el PDF: ' + err.message;
      estadoExtraccion.className = 'extract-status warn';
    }
  });

  const acciones = document.createElement('div');
  acciones.className = 'form-actions';
  acciones.append(
    crearBoton('Cancelar', 'btn-outline', cerrarModal),
    (() => {
      const b = document.createElement('button');
      b.type = 'submit';
      b.className = 'btn btn-primary';
      b.textContent = 'Guardar factura';
      return b;
    })()
  );
  form.appendChild(acciones);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!archivoElegido) { toast('Elegi un PDF', true); return; }
    try {
      await adjuntarFactura(job, {
        numeroFactura: inputNumero.value,
        fechaFactura: inputFecha.value,
        montoFactura: inputMonto.value,
        file: archivoElegido,
      });
      toast('Factura guardada, empieza a contar los dias sin cobrar');
      cerrarModal();
      cargarTrabajos();
    } catch (err) {
      toast(err.message, true);
    }
  });

  abrirModal('Subir factura', form);
}

// ---------- modal: orden de pago ----------

function abrirModalOrdenPago(job) {
  const form = document.createElement('form');
  let archivoElegido = null;

  const inputFile = document.createElement('input');
  inputFile.type = 'file';
  inputFile.accept = 'application/pdf';
  inputFile.required = true;

  const inputFecha = document.createElement('input');
  inputFecha.type = 'date';
  inputFecha.value = hoyISO();
  inputFecha.max = hoyISO();

  const estadoExtraccion = status(`Presupuesto ${job.presupuesto.numero}. Al guardar, el trabajo pasa a "Pagado".`);
  const candFecha = contenedorCandidatos();

  form.appendChild(fieldGroup('Documento PDF de la orden de pago', inputFile));
  form.appendChild(estadoExtraccion);
  form.appendChild(fieldGroup('Fecha de pago', inputFecha));
  form.appendChild(candFecha);

  const retencionesCampos = impuestosUI.camposRetenciones();
  form.appendChild(retencionesCampos.elemento);

  inputFile.addEventListener('change', async () => {
    const file = inputFile.files[0];
    if (!file) return;
    archivoElegido = file;
    try {
      const res = await extraer('orden_pago', file);
      pintarCandidatosFecha(candFecha, res.candidates.dates, inputFecha);
    } catch (err) {
      estadoExtraccion.textContent = 'No se pudo leer el PDF: ' + err.message;
      estadoExtraccion.className = 'extract-status warn';
    }
  });

  const acciones = document.createElement('div');
  acciones.className = 'form-actions';
  acciones.append(
    crearBoton('Cancelar', 'btn-outline', cerrarModal),
    (() => {
      const b = document.createElement('button');
      b.type = 'submit';
      b.className = 'btn btn-primary';
      b.textContent = 'Marcar como pagado';
      return b;
    })()
  );
  form.appendChild(acciones);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!archivoElegido) { toast('Elegi un PDF', true); return; }
    try {
      const retenciones = retencionesCampos.leer();
      await adjuntarOrdenPago(job, { fechaPago: inputFecha.value, file: archivoElegido, retenciones });
      toast('Trabajo marcado como pagado');
      cerrarModal();
      cargarTrabajos();
    } catch (err) {
      toast(err.message, true);
    }
  });

  abrirModal('Subir orden de pago', form);
}

// ---------- modal: edicion manual ----------

function abrirModalEditar(job) {
  const form = document.createElement('form');

  const inputNumero = document.createElement('input');
  inputNumero.type = 'text';
  inputNumero.value = job.presupuesto.numero;

  const inputDesc = document.createElement('textarea');
  inputDesc.value = job.presupuesto.descripcion || '';

  const inputMonto = document.createElement('input');
  inputMonto.type = 'number';
  inputMonto.step = '0.01';
  inputMonto.value = job.presupuesto.monto ?? '';

  const inputMontoIva = document.createElement('input');
  inputMontoIva.type = 'number';
  inputMontoIva.step = '0.01';
  inputMontoIva.value = job.presupuesto.montoIva ?? '';

  inputMonto.addEventListener('input', () => {
    const m = parseFloat(inputMonto.value);
    if (Number.isFinite(m) && m > 0) inputMontoIva.value = conIva(m);
  });

  form.appendChild(fieldGroup('Numero de presupuesto', inputNumero));
  form.appendChild(fieldGroup('Descripcion del trabajo', inputDesc));
  form.appendChild(fieldGroup('Monto (sin IVA)', inputMonto, 'El monto con IVA se recalcula solo (21%) al tocar este campo.'));
  form.appendChild(fieldGroup('Monto con IVA', inputMontoIva));

  let inputOC = null;
  if (job.ordenCompra) {
    inputOC = document.createElement('input');
    inputOC.type = 'text';
    inputOC.value = job.ordenCompra.numero;
    form.appendChild(fieldGroup('Numero de orden de compra', inputOC));
  }

  let inputNumeroFactura = null, inputFecha = null, inputMontoFactura = null;
  if (job.factura) {
    inputNumeroFactura = document.createElement('input');
    inputNumeroFactura.type = 'text';
    inputNumeroFactura.value = job.factura.numero || '';
    form.appendChild(fieldGroup('Numero de factura', inputNumeroFactura));

    inputFecha = document.createElement('input');
    inputFecha.type = 'date';
    inputFecha.value = job.factura.fecha;
    inputFecha.max = hoyISO();
    form.appendChild(fieldGroup('Fecha de factura', inputFecha));

    inputMontoFactura = document.createElement('input');
    inputMontoFactura.type = 'number';
    inputMontoFactura.step = '0.01';
    inputMontoFactura.value = job.factura.monto ?? '';
    form.appendChild(fieldGroup('Monto confirmado con IVA (factura)', inputMontoFactura));
  }

  let retencionesCampos = null;
  if (job.pago && job.pago.pagado) {
    retencionesCampos = impuestosUI.camposRetenciones(job.pago.retenciones || {});
    form.appendChild(retencionesCampos.elemento);
  }

  const acciones = document.createElement('div');
  acciones.className = 'form-actions';
  acciones.append(
    crearBoton('Cancelar', 'btn-outline', cerrarModal),
    (() => {
      const b = document.createElement('button');
      b.type = 'submit';
      b.className = 'btn btn-primary';
      b.textContent = 'Guardar cambios';
      return b;
    })()
  );
  form.appendChild(acciones);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = {
      presupuesto: {
        numero: inputNumero.value,
        descripcion: inputDesc.value,
        monto: inputMonto.value === '' ? null : Number(inputMonto.value),
        montoIva: inputMontoIva.value === '' ? null : Number(inputMontoIva.value),
      },
    };
    if (inputOC) patch.ordenCompra = { numero: inputOC.value };
    if (inputFecha) {
      patch.factura = {
        numero: inputNumeroFactura.value,
        fecha: inputFecha.value,
        monto: inputMontoFactura.value === '' ? null : Number(inputMontoFactura.value),
      };
    }

    try {
      if (retencionesCampos) patch.pago = { retenciones: retencionesCampos.leer() };
      await editarJob(job, patch);
      toast('Cambios guardados');
      cerrarModal();
      cargarTrabajos();
    } catch (err) {
      toast(err.message, true);
    }
  });

  abrirModal(`Editar ${job.presupuesto.numero}`, form);
}

document.getElementById('btn-nuevo').addEventListener('click', abrirModalNuevo);
