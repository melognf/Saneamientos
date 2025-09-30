// app.js v13.1 — login + ciclos + timeline + mail (Apps Script)
import { db, auth } from './firebase-config.js';
import {
  doc, getDoc, onSnapshot, runTransaction, setDoc,
  collection, orderBy, query, limit, serverTimestamp,
  where, getDocs, writeBatch, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged, signInAnonymously, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// --- URL del Web App de Apps Script (tu deployment activo) ---
const APPSCRIPT_URL = "https://script.google.com/macros/s/AKfycbwnubDMBx16ZJMhNE410j2_WlMUkP_o3AqQE6yu0k8ghmverxbe6tBJMBmQzPQV-h1XbA/exec";

// --- constantes de export del gráfico ---
const EXPORT_DPR = 2;                  // escala del PNG/JPEG al exportar
const MAX_DATURL_BYTES = 900_000;      // si el PNG excede esto, intento JPEG

let cycleChart = null, unsubCycles = null;
const BOARD_ID = 'llenadora';

// Escala del timeline y layout del chart
const PX_PER_MIN       = 50;           // ↑ un poco para evitar compresión horizontal
const MIN_CANVAS_W     = 700;
const CHART_ROW_HEIGHT = 38;           // altura por fila (label)
const CHART_MIN_HEIGHT = 220;          // altura mínima
/** Colores de estilo */

// ===== Nota preformateada (sabores) =====
const NOTE_TEMPLATE = 'S:  | P: ';
function isNoteTemplate(v){
  return !v || /^s:\s*\|\s*p:\s*$/i.test(String(v).trim());
}
function ensureNoteTemplate(){
  if (!notaInput) return;
  if (!notaInput.value || isNoteTemplate(notaInput.value)) {
    notaInput.value = NOTE_TEMPLATE;
  }
}

// Estados
const STATES = [
  { key:'sin_solicitud',    label:'Sin solicitud de CIP' },
  { key:'cip_solicitado',   label:'CIP solicitado por Operación' },
  { key:'cip_en_curso',     label:'CIP en curso (Elaboración)' },
  { key:'hisopado_pend',    label:'CIP finalizado: hisopado pendiente' },
  { key:'hisopado_en_curso',label:'Hisopado en curso (Materias)' },
  { key:'hisopado_ok',      label:'Hisopado OK (Listo para arranque)' },
  { key:'arranque_en_curso',label:'Arranque en curso' },
  { key:'produccion_ok',    label:'Producción OK' }
];

// Transiciones por rol
const TRANSITIONS = {
  operacion: {
    sin_solicitud:       [ {to:'cip_solicitado', action:'Solicitar CIP'} ],
    hisopado_ok:         [ {to:'arranque_en_curso', action:'Iniciar arranque'} ],
    arranque_en_curso:   [
      {to:'produccion_ok', action:'Confirmar producción OK'},
      {to:'sin_solicitud', action:'Cancelar y reiniciar'}
    ],
    produccion_ok:       [ {to:'sin_solicitud', action:'Nuevo cambio de sabor'} ]
  },
  elaboracion: {
    cip_solicitado: [ {to:'cip_en_curso', action:'Iniciar CIP'} ],
    cip_en_curso:   [ {to:'hisopado_pend', action:'Finalizar CIP (pedir hisopado)'} ]
  },
  materias: {
    hisopado_pend:     [ {to:'hisopado_en_curso', action:'Iniciar hisopado'} ],
    hisopado_en_curso: [ {to:'hisopado_ok', action:'Aprobar (OK)'}, {to:'cip_solicitado', action:'Re-CIP'} ]
  }
};

let USER=null, ROLE=null, currentState='sin_solicitud', boardCycle=1;
let unsubBoard=null, unsubLogs=null;

// ---------- UI refs ----------
const loginBox     = document.getElementById('loginBox');
const loggedBox    = document.getElementById('loggedBox');
const roleBadge    = document.getElementById('roleBadge');
const roleName     = document.getElementById('roleName');
const roleHint     = document.getElementById('roleHint');
const logoutBtn    = document.getElementById('logout');
const sectorSel    = document.getElementById('sector');
const pinInput     = document.getElementById('pin');
const btnLogin     = document.getElementById('btnLogin');
const estadoLabel  = document.getElementById('estadoLabel');
const stepperBox   = document.getElementById('stepper');
const actionsBox   = document.getElementById('actions');
const logList      = document.getElementById('logList');
const notaInput    = document.getElementById('nota');
const initBox      = document.getElementById('initBox');
const btnInitBoard = document.getElementById('btnInitBoard');
const projInfo     = document.getElementById('projInfo');
const chartCanvas  = document.getElementById('chartCycle');

projInfo.textContent = 'Proyecto: ' + (window.__FIREBASE_PROJECT_ID__ || '(sin config)');
console.log('Firebase projectId:', window.__FIREBASE_PROJECT_ID__);

// Inicializo el molde de nota y dejo el cursor antes del “|”
ensureNoteTemplate();
notaInput?.addEventListener('focus', () => {
  if (isNoteTemplate(notaInput.value)) {
    const pos = Math.max(0, NOTE_TEMPLATE.indexOf('|'));
    requestAnimationFrame(()=> notaInput.setSelectionRange(pos, pos));
  }
});

// ---------- Helpers fecha ----------
function hasTZ(tz){
  try { new Intl.DateTimeFormat('es-AR', { timeZone: tz }).format(new Date()); return true; }
  catch { return false; }
}
const TZ = hasTZ('America/Argentina/Buenos_Aires')
  ? 'America/Argentina/Buenos_Aires'
  : (hasTZ('America/Buenos_Aires') ? 'America/Buenos_Aires' : 'UTC');

const LOCALE = 'es-AR';
function formatTs(ts) {
  const d = ts?.toDate ? ts.toDate() : new Date();
  return new Intl.DateTimeFormat(LOCALE, {
    year:'2-digit', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    hour12:false, timeZone: TZ
  }).format(d);
}

// ---------- Misc utils ----------
function stateIndex(key){ return STATES.findIndex(s=>s.key===key); }
function labelFromKey(key){ const s=STATES.find(x=>x.key===key); return s? s.label: key; }
function prettyRole(r){ return r==='operacion'?'Operación':(r==='elaboracion'?'Elaboración':(r==='materias'?'Materias Primas':String(r))); }
function escapeHtml(s){ const map={ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }; return String(s).replace(/[&<>"']/g,m=>map[m]); }
function canTransition(role, from, to){ const opts=(TRANSITIONS[role]&&TRANSITIONS[role][from])||[]; return opts.some(o=>o.to===to); }
function msToMin(ms){ return Math.round((ms/60000)*100)/100; }
const waitForPaint = () => new Promise(r => requestAnimationFrame(()=>r()));

// ---------- Init/Listeners ----------
btnInitBoard?.addEventListener('click', createBoard);
btnLogin?.addEventListener('click', () => doLogin());
pinInput?.addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
logoutBtn?.addEventListener('click', () => signOut(auth));

// ---------- Auth flow ----------
async function doLogin(){
  const role = sectorSel.value;
  const pin  = (pinInput?.value||'').trim();
  if(!pin){ alert('Ingresá el PIN del sector'); return; }

  sessionStorage.setItem('pending_role', role);
  sessionStorage.setItem('pending_pin', pin);

  try{
    if(!auth.currentUser){ await signInAnonymously(auth); }
    const uid = auth.currentUser.uid;
    const uref = doc(db,'users',uid);

    let usnap;
    try { usnap = await getDoc(uref); }
    catch(e){ console.error('READ users/{uid} error', e); alert('Permiso al leer users denegado. Revisá Rules.'); return; }

    if(!usnap.exists()){
      try{
        await runTransaction(db, async (tx)=>{ tx.set(uref, { role, pin, createdAt: serverTimestamp() }); });
        console.log('users doc creado OK');
      }catch(e){
        console.error('CREATE users/{uid} error', e);
        alert('No se pudo crear el usuario: '+e.message);
        return;
      }
      usnap = await getDoc(uref);
    }

    ROLE = usnap.exists()? (usnap.data().role||null): null;
    if(!ROLE){ alert('No se pudo asignar rol.'); return; }

    pinInput.value='';
    render(); setupSubs();

  }catch(err){
    console.error('Login error', err);
    alert('No se pudo iniciar: '+err.message);
  }
}

onAuthStateChanged(auth, async (user)=>{
  USER = user||null;
  if(!USER){ ROLE=null; teardownSubs(); render(); return; }
  try{
    const uref = doc(db,'users',USER.uid);
    let usnap = await getDoc(uref);
    if(!usnap.exists()){
      const role=sessionStorage.getItem('pending_role');
      const pin=sessionStorage.getItem('pending_pin');
      if(role && pin){
        try{ await runTransaction(db, async (tx)=>{ tx.set(uref, { role, pin, createdAt: serverTimestamp() }); }); }
        catch(e){ console.warn('Tx onAuth create users failed', e); }
        usnap = await getDoc(uref);
      }
    }
    ROLE = usnap.exists()? (usnap.data().role||null): null;
  }catch(e){ console.error(e); }
  render(); setupSubs();
});

// ---------- Subscripción estado + logs + último ciclo ----------
function setupSubs(){
  const bref = doc(db, 'tableros', BOARD_ID);

  if (unsubBoard) unsubBoard();
  unsubBoard = onSnapshot(bref, snap => {
    if (!snap.exists()) {
      estadoLabel.textContent = 'Sin inicializar (crear doc tableros/llenadora)';
      initBox.style.display = 'flex';
      return;
    }
    initBox.style.display = 'none';
    const data = snap.data();
    currentState = data.current || 'sin_solicitud';
    boardCycle   = data.cycle   || 1;
    renderStepper();
    renderActions();
    estadoLabel.textContent = labelFromKey(currentState);
  });

  // ---- Logs (con metadatos) ----
  const qLogs = query(
    collection(db, 'tableros', BOARD_ID, 'logs'),
    orderBy('ts', 'desc'),
    limit(500)
  );

  if (unsubLogs) unsubLogs();
  unsubLogs = onSnapshot(qLogs, { includeMetadataChanges: true }, snap => {
    logList.innerHTML = '';
    if (snap.empty) {
      const empty = document.createElement('div');
      empty.style.opacity = .7;
      empty.textContent = 'Sin movimientos aún.';
      logList.appendChild(empty);
      return;
    }

    // Agrupar por ciclo (desc)
    const groups = new Map();
    snap.forEach(docSnap => {
      const item = { id: docSnap.id, ...docSnap.data(), _meta: docSnap.metadata };
      const cyc = Number.isFinite(item.cycle) ? item.cycle : 0;
      if (!groups.has(cyc)) groups.set(cyc, []);
      groups.get(cyc).push(item);
    });
    const cyclesDesc = Array.from(groups.keys()).sort((a,b)=>b-a);

    // Alternado por índice para color (even/odd)
    cyclesDesc.forEach((cyc, idx) => {
      const stripeClass = (idx % 2 === 0) ? 'even' : 'odd';
      // Cabecera de ciclo
      const head = document.createElement('div');
      head.className = `cycle-head ${stripeClass}`;
      head.textContent = `Ciclo ${cyc}`;
      logList.appendChild(head);
      // Items del ciclo
      for (const item of groups.get(cyc)){
        const when = formatTs(item.ts);
        const nota = item.note ? ' · Nota: ' + escapeHtml(item.note) : '';
        const pendiente = (item._meta?.hasPendingWrites || snap.metadata?.hasPendingWrites) ? ' (pendiente)' : '';
        const row = document.createElement('div');
        row.className = `log-item ${stripeClass}`;
        row.innerHTML = `
          <time title="${TZ}${pendiente}">${when}</time>
          <div><strong>${prettyRole(item.role)}</strong> → <em>${item.action}</em>
          · Estado: <strong>${labelFromKey(item.to)}</strong>${nota}</div>`;
        logList.appendChild(row);
      }
    });
  });

  // ---- Último ciclo (para el gráfico) ----
  const qCycle = query(
    collection(db, 'tableros', BOARD_ID, 'cycles'),
    orderBy('cycle', 'desc'),
    limit(1)
  );
  if (unsubCycles) unsubCycles();
  unsubCycles = onSnapshot(qCycle, s => {
    if (s.empty) return;
    const doc = s.docs[0].data();
    renderCycleChart(doc);
  });
}

function teardownSubs(){
  if(unsubBoard){ unsubBoard(); unsubBoard=null; }
  if(unsubLogs){ unsubLogs(); unsubLogs=null; }
  if(unsubCycles){ unsubCycles(); unsubCycles=null; }
}

// ---------- Render ----------
function render(){
  if(USER && ROLE){
    loginBox.style.display='none';
    loggedBox.style.display='block';
    roleBadge.hidden=false;
    roleName.textContent=prettyRole(ROLE);
    roleHint.textContent=USER.isAnonymous?'Anon demo':'activo';
  } else {
    loginBox.style.display='flex';
    loggedBox.style.display='none';
    roleBadge.hidden=true;
  }
  renderStepper();
  renderActions();
  estadoLabel.textContent=labelFromKey(currentState);
  // Aseguro el molde de la nota visible para el usuario
  ensureNoteTemplate();
}

// Pasos activos (parpadeo vía CSS de tu hoja)
function renderStepper(){
  stepperBox.innerHTML = '';
  const curIdx = stateIndex(currentState);
  STATES.forEach((s, idx) => {
    const el = document.createElement('div');
    el.className = 'step';
    if (idx < curIdx) el.classList.add('done');
    if (idx === curIdx) el.classList.add('active');
    el.dataset.key = s.key;
    el.innerHTML = `<div class="dot"></div><div style="font-size:12px">${idx+1}. ${s.label}</div>`;
    stepperBox.appendChild(el);
  });
}

function renderActions(){
  actionsBox.innerHTML='';
  if(!USER||!ROLE){ return; }
  const opts=(TRANSITIONS[ROLE]&&TRANSITIONS[ROLE][currentState])||[];
  if(!opts.length){
    const none=document.createElement('div');
    none.style.opacity=.75;
    none.textContent='Sin acciones disponibles para tu sector en este estado.';
    actionsBox.appendChild(none);
  } else {
    for(const op of opts){
      const b=document.createElement('button');
      b.className='btn primary row';
      b.textContent=op.action;
      b.addEventListener('click',()=>applyTransition(op.to, op.action));
      actionsBox.appendChild(b);
    }
  }

  // Botón ABORTAR (solo Operación)
  if (ROLE === 'operacion' && currentState !== 'sin_solicitud') {
    const abortBtn = document.createElement('button');
    abortBtn.className = 'btn';
    abortBtn.style.background = 'var(--fail)';
    abortBtn.style.color = '#fff';
    abortBtn.textContent = 'Abortar ciclo (volver a 0)';
    abortBtn.onclick = abortCycle;
    actionsBox.appendChild(abortBtn);
  }

  // Limpieza (solo Operación)
  if (ROLE === 'operacion') {
    const row = document.createElement('div');
    row.style.display='flex'; row.style.gap='8px'; row.style.flexWrap='wrap';

    const b1 = document.createElement('button');
    b1.className='btn ghost';
    b1.textContent='Borrar ciclo ACTUAL';
    b1.title='Elimina los logs del ciclo en curso y su resumen';
    b1.onclick = clearCurrentCycle;

    const b2 = document.createElement('button');
    b2.className='btn ghost';
    b2.textContent='Borrar TODO el historial';
    b2.title='Elimina TODOS los logs y resúmenes y reinicia el tablero';
    b2.onclick = clearAllHistory;

    row.appendChild(b1); row.appendChild(b2);
    actionsBox.appendChild(row);
  }
}

// ---------- Transición + cierre de ciclo + resumen + mail ----------
async function applyTransition(nextKey, actionLabel){
  if (!USER || !ROLE) return;

  if (!canTransition(ROLE, currentState, nextKey)) {
    alert('Transición no permitida para tu sector.');
    return;
  }

  // Nota: no guardar el molde vacío "S:  | P: "
  const rawNote = (notaInput?.value || '').trim();
  const note = isNoteTemplate(rawNote) ? '' : rawNote;

  const boardRef = doc(db, 'tableros', BOARD_ID);
  const logRef   = doc(collection(db, 'tableros', BOARD_ID, 'logs')); // ID auto

  let usedCycle = null;

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(boardRef);
      if (!snap.exists()) throw new Error('El tablero no está inicializado.');

      const cur   = snap.data().current;
      const cycle = snap.data().cycle || 1;
      usedCycle   = cycle;

      if (!canTransition(ROLE, cur, nextKey)) {
        throw new Error('El estado cambió; actualizá.');
      }

      // Avance de ciclo cuando volvemos a sin_solicitud (nuevo ciclo)
      let newCycle = cycle;
      if (nextKey === 'sin_solicitud' && currentState !== 'sin_solicitud') {
        newCycle = cycle + 1;
      }

      // Estado tablero (+ posible incremento de ciclo)
      const updateData = { current: nextKey, updatedAt: serverTimestamp() };
      if (newCycle !== cycle) updateData.cycle = newCycle;
      tx.update(boardRef, updateData);

      // Log: si arranca nuevo ciclo, el log pertenece al ciclo nuevo
      tx.set(logRef, {
        ts: serverTimestamp(),
        uid: (auth.currentUser?.uid) || 'anon',
        role: ROLE,
        from: cur,
        to: nextKey,
        action: actionLabel,
        note,
        cycle: newCycle
      });

      // Si cerramos en 'produccion_ok', el resumen corresponde al ciclo que cierra
      if (nextKey === 'produccion_ok') {
        usedCycle = cycle;
      }
    });

    // Dejo otra vez el molde listo para completar próximos sabores
    if (notaInput) notaInput.value = NOTE_TEMPLATE;

    // Si llegamos a producción ok → resumen + mail
    if (nextKey === 'produccion_ok' && usedCycle != null) {
      const summary = await computeAndSaveTaskTimelineSummary(usedCycle);
      // Esperar a que el chart termine de dibujar
      await waitForPaint();
      await new Promise(r => setTimeout(r, 120));
      const chartUrlPNG = await captureChartPNG(chartCanvas, EXPORT_DPR);
      const chartUrl = (chartUrlPNG && chartUrlPNG.length > MAX_DATURL_BYTES)
        ? await captureChartAsJPEG(chartCanvas, 0.88)
        : chartUrlPNG;
      await sendReportFromSummary(usedCycle, summary, chartUrl);
    }

  } catch (e) {
    console.error(e);
    alert('No se pudo aplicar: ' + e.message);
  }
}

// ---------- ABORTAR CICLO ----------
async function abortCycle(){
  if(!USER || ROLE !== 'operacion') return;
  if(currentState === 'sin_solicitud') return;

  const motivo = prompt('⚠️ Vas a ABORTAR el ciclo actual y volver a 0.\nOpcional: escribí un motivo.');
  if(motivo === null) return;

  const boardRef = doc(db,'tableros',BOARD_ID);
  const logsCol  = collection(db, 'tableros', BOARD_ID, 'logs');
  const logRef   = doc(logsCol); // id auto

  let cycleUsed = null;

  try{
    await runTransaction(db, async (tx)=>{
      const snap = await tx.get(boardRef);
      if(!snap.exists()) throw new Error('El tablero no está inicializado.');
      const cur   = snap.data().current;
      const cycle = snap.data().cycle || 1;
      cycleUsed   = cycle;

      tx.update(boardRef, {
        current: 'sin_solicitud',
        updatedAt: serverTimestamp(),
        cycle: cycle + 1
      });

      tx.set(logRef, {
        ts: serverTimestamp(),
        uid: (auth.currentUser?.uid)||'anon',
        role: 'operacion',
        from: cur,
        to: 'sin_solicitud',
        action: 'Abortar ciclo',
        note: motivo||'',
        cycle
      });
    });

    if (cycleUsed != null) {
      await computeAndSaveTaskTimelineSummary(cycleUsed, { aborted: true, abortReason: motivo||'' });
    }
  }catch(e){
    console.error(e);
    alert('No se pudo abortar: ' + e.message);
  }
}

// ---------- BORRAR CICLO ACTUAL ----------
async function clearCurrentCycle(){
  if(ROLE !== 'operacion'){ alert('Solo Operación puede borrar.'); return; }
  const ok = confirm('¿Borrar SOLO el ciclo ACTUAL? Esto eliminará los logs (y el resumen si existe).');
  if(!ok) return;

  try{
    const col = collection(db, 'tableros', BOARD_ID, 'logs');
    await deleteCollectionBatched(query(col, where('cycle','==', boardCycle), limit(300)));
    try { await deleteDoc(doc(db, 'tableros', BOARD_ID, 'cycles', String(boardCycle))); } catch{}
    alert('Ciclo actual borrado.');
  }catch(e){
    console.error(e); alert('No se pudo borrar el ciclo actual: '+e.message);
  }
}

// ---------- BORRAR TODO EL HISTORIAL ----------
async function clearAllHistory(){
  if(ROLE !== 'operacion'){ alert('Solo Operación puede borrar.'); return; }
  const ok = confirm('⚠️ Esto BORRARÁ TODOS los logs y resúmenes y reiniciará el tablero. ¿Continuar?');
  if(!ok) return;
  const ok2 = confirm('Confirmá nuevamente: se eliminará TODO el historial.');
  if(!ok2) return;

  try{
    await deleteCollectionBatched(query(collection(db,'tableros',BOARD_ID,'logs'),   limit(300)));
    await deleteCollectionBatched(query(collection(db,'tableros',BOARD_ID,'cycles'), limit(300)));
    await setDoc(
      doc(db,'tableros',BOARD_ID),
      { current:'sin_solicitud', cycle: 1, updatedAt: serverTimestamp() },
      { merge: true }
    );
    alert('Historial borrado y tablero reiniciado.');
  }catch(e){
    console.error(e); alert('No se pudo borrar todo: '+e.message);
  }
}

// ---------- Borrado por lotes ----------
async function deleteCollectionBatched(qRef){
  while(true){
    const snap = await getDocs(qRef);
    if(snap.empty) break;
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < 300) break;
  }
}

// ---------- Resumen tipo timeline ----------
async function computeAndSaveTaskTimelineSummary(cycleId, extraMeta = {}){
  // Traer logs del ciclo y ordenar en cliente
  const qLogs = query(
    collection(db, 'tableros', BOARD_ID, 'logs'),
    where('cycle', '==', cycleId)
  );
  const snap = await getDocs(qLogs);
  if (snap.empty) return null;

  const logs = [];
  snap.forEach(d => logs.push({ id:d.id, ...d.data() }));
  logs.sort((a,b) => a.ts.toDate() - b.ts.toDate()); // asc

  const PAIRS = [
    { from:'cip_solicitado',   to:'cip_en_curso',     label:'Demora inicio CIP',         color:'#f59e0b' },
    { from:'cip_en_curso',     to:'hisopado_pend',    label:'Duración CIP',              color:'#2563eb' },
    { from:'hisopado_pend',    to:'hisopado_en_curso',label:'Demora inicio hisopado',    color:'#f59e0b' },
    { from:'hisopado_en_curso',to:'hisopado_ok',      label:'Duración hisopado',         color:'#16a34a' },
    { from:'hisopado_ok',      to:'arranque_en_curso',label:'Demora inicio arranque',    color:'#f59e0b' },
    { from:'arranque_en_curso',to:'produccion_ok',    label:'Duración arranque',         color:'#7c3aed' }
  ];

  const firstFromIdx = logs.findIndex(lg => PAIRS.some(p => lg.to === p.from));
  const t0 = (firstFromIdx !== -1)
    ? logs[firstFromIdx].ts.toDate().getTime()
    : logs[0].ts.toDate().getTime();

  const segments = [];
  const accMs = new Array(PAIRS.length).fill(0);
  const waiting = new Array(PAIRS.length).fill(null);

  for (const lg of logs){
    const t = lg.ts.toDate().getTime();
    for (let i=0; i<PAIRS.length; i++){
      const p = PAIRS[i];
      if (lg.to === p.from){
        waiting[i] = t;
      } else if (lg.to === p.to && waiting[i] != null){
        const startMin = msToMin(waiting[i] - t0);
        const endMin   = msToMin(t - t0);
        accMs[i] += Math.max(0, t - waiting[i]);
        segments.push({ key:`${p.from}->${p.to}`, label:p.label, startMin, endMin, color:p.color });
        waiting[i] = null;
      }
    }
  }

  const pairs = PAIRS.map((p,i)=>({ key:`${p.from}->${p.to}`, label:p.label, ms:accMs[i], min:msToMin(accMs[i]) }));

  const meta = {
    cycle: cycleId,
    startedAt: logs[0].ts,
    finishedAt: logs[logs.length-1].ts,
    totalMin: Math.round(pairs.reduce((a,b)=>a+b.min,0)*100)/100,
    createdAt: serverTimestamp()
  };

  const summary = { pairs, segments, ...meta, ...extraMeta };
  const ref = doc(db, 'tableros', BOARD_ID, 'cycles', String(cycleId));
  await setDoc(ref, summary);
  renderCycleChart(summary);
  return summary;
}

// ---------- Gráfico Timeline ----------
function renderCycleChart(summary){
  const el = chartCanvas;
  if (!el) return;

  // Chart.js presente
  if (typeof Chart === 'undefined' || !Chart) {
    console.warn('Chart.js no está cargado. Agregá <script src="https://cdn.jsdelivr.net/npm/chart.js"></script> antes de app.js');
    return;
  }

  try {
    // destruir instancia previa
    if (cycleChart) { cycleChart.destroy(); cycleChart = null; }

    // contenedor con scroll horizontal
    const container = el.parentElement;
    if (container) container.style.overflowX = 'auto';

    // calcular span total (min) para el ancho del canvas
    let totalSpanMin = 0;
    if (Array.isArray(summary?.segments) && summary.segments.length > 0) {
      totalSpanMin = Math.max(...summary.segments.map(s => Number(s?.endMin) || 0));
    } else if (Array.isArray(summary?.pairs) && summary.pairs.length > 0) {
      totalSpanMin = summary.pairs.reduce((acc, p) => acc + (Number(p?.min) || 0), 0);
    }

    const desiredPx = Math.max(MIN_CANVAS_W, Math.ceil(totalSpanMin * PX_PER_MIN));
    el.style.width  = desiredPx + 'px';
    el.style.height = '260px'; // valor base; abajo lo ajustamos si hace falta

    const xSuggestedMax = Math.max(0, Math.ceil(totalSpanMin * 1.05));

    // ---- Caso principal: timeline con segments (rangos [startMin, endMin]) ----
    if (Array.isArray(summary?.segments) && summary.segments.length){
      const labels = Array.from(new Set(
        summary.segments.map(s => s?.label).filter(Boolean)
      ));

      // Alto dinámico por cantidad de filas
      const rows = Math.max(1, labels.length);
      const rowHeight = 34;   // px por fila
      const minHeight = 240;  // piso cómodo
      el.style.height = Math.max(minHeight, rows * rowHeight) + 'px';

      const datasets = summary.segments.map(seg => ({
        label: seg.label || '',
        stack: 'timeline',
        data: labels.map(lbl => lbl === (seg.label || '') ? [
          Number(seg.startMin) || 0,
          Number(seg.endMin)   || 0
        ] : null),
        backgroundColor: seg.color || '#999',
        borderColor: seg.color || '#999',
        borderWidth: 0,
        borderSkipped: false,
        barPercentage: 1,
        categoryPercentage: 1
      }));

      cycleChart = new Chart(el.getContext('2d'), {
        type: 'bar',
        data: { labels, datasets },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { stacked: true },
            x: {
              beginAtZero: true,
              min: 0,
              suggestedMax: xSuggestedMax,
              title: { display: true, text: 'min desde inicio del ciclo' }
            }
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const v = ctx.raw;
                  if (Array.isArray(v)) {
                    const dur = Math.max(0, (v[1] - v[0])).toFixed(2);
                    return `${ctx.dataset.label}: ${v[0].toFixed(2)} → ${v[1].toFixed(2)} min (duración ${dur} min)`;
                  }
                  return ctx.formattedValue;
                }
              }
            }
          }
        }
      });
      return;
    }

    // ---- Fallback: solo pairs (barras simples por tarea) ----
    if (Array.isArray(summary?.pairs) && summary.pairs.length){
      const filtered = summary.pairs
        .map(p => ({ label: String(p?.label || ''), min: Number(p?.min) || 0 }))
        .filter(p => p.min > 0);

      const labels = filtered.map(x => x.label);
      const dataMin = filtered.map(x => x.min);

      // Alto dinámico también acá
      const rows = Math.max(1, labels.length);
      el.style.height = Math.max(200, rows * 28) + 'px';

      cycleChart = new Chart(el.getContext('2d'), {
        type: 'bar',
        data: { labels, datasets: [{ label:`Duración por tarea${summary?.cycle ? ` (ciclo ${summary.cycle})` : ''}`, data: dataMin }] },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              beginAtZero: true,
              min: 0,
              suggestedMax: xSuggestedMax,
              title: { display: true, text: 'min' }
            }
          },
          plugins: { legend: { display: false } }
        }
      });
      return;
    }

    // Si no hay datos, limpiar
    const ctx = el.getContext('2d');
    ctx && ctx.clearRect(0, 0, el.width, el.height);

  } catch (e) {
    console.error('renderCycleChart error:', e, summary);
  }
}

// ---------- Captura de gráfico ----------
async function captureChartPNG(canvas, dpr = 2){
  if (!canvas) return null;
  try{
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(canvas.width,  Math.round(rect.width  * dpr));
    const h = Math.max(canvas.height, Math.round(rect.height * dpr));
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext('2d');

    // fondo tomado del body (evita transparencias raras en email/pdf)
    try{
      const bg = getComputedStyle(document.body).backgroundColor || '#0b1020';
      ctx.fillStyle = bg; ctx.fillRect(0,0,w,h);
    }catch{}

    ctx.drawImage(canvas, 0, 0, w, h);
    return tmp.toDataURL('image/png');
  }catch(e){
    console.warn('No se pudo capturar PNG:', e);
    return null;
  }
}

async function captureChartAsJPEG(canvas, quality = 0.82){
  if (!canvas) return null;
  try{
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(canvas.width,  Math.round(rect.width  * EXPORT_DPR));
    const h = Math.max(canvas.height, Math.round(rect.height * EXPORT_DPR));
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext('2d');
    // fondo sólido
    ctx.fillStyle = '#0b1020'; ctx.fillRect(0,0,w,h);
    ctx.drawImage(canvas, 0, 0, w, h);
    return tmp.toDataURL('image/jpeg', quality);
  }catch(e){
    console.warn('No se pudo capturar JPEG:', e);
    return null;
  }
}

// ---------- Envío de reporte (desde summary) ----------
async function sendReportFromSummary(cycleId, summary, chartUrl){
  if (!APPSCRIPT_URL) return;
  try{
    const pairs = Array.isArray(summary?.pairs)
      ? summary.pairs.map(p => ({ label:p.label, min: Math.round((p.min||0)*100)/100 }))
      : [];
    const totalMin = typeof summary?.totalMin === 'number'
      ? Math.round(summary.totalMin*100)/100
      : pairs.reduce((a,b)=>a+(b.min||0),0);

    // Logs del ciclo SIN orderBy; ordeno en cliente
    let logs = [];
    try{
      const logsSnap = await getDocs(query(
        collection(db, 'tableros', BOARD_ID, 'logs'),
        where('cycle','==', cycleId)
      ));
      logsSnap.forEach(d => {
        const it = d.data();
        logs.push({
          when: it.ts?.toDate ? it.ts.toDate().toISOString() : null,
          role: it.role, action: it.action, to: it.to, note: it.note||''
        });
      });
      logs.sort((a,b)=> (a.when||'').localeCompare(b.when||''));
    }catch(e){
      console.warn('Logs del ciclo no disponibles, sigo sin logs:', e);
    }

    const payload = {
      boardId: BOARD_ID,
      cycleId,
      totalMin,
      pairs,
      chartUrl: chartUrl || null,
      startedAt: summary.startedAt?.toDate ? summary.startedAt.toDate().toISOString() : null,
      finishedAt: summary.finishedAt?.toDate ? summary.finishedAt.toDate().toISOString() : null,
      logs
    };

    console.log('[report] POST → Apps Script', {cycleId, pairs: pairs.length, logs: logs.length, hasChart: !!chartUrl});
    await fetch(APPSCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });
    console.log('[report] Disparado (no-cors).');

  }catch(e){
    console.warn('sendReportFromSummary falló:', e);
  }
}

// ---------- Crear tablero ----------
async function createBoard() {
  try{
    await setDoc(
      doc(db,'tableros',BOARD_ID),
      { current:'sin_solicitud', cycle: 1, updatedAt: serverTimestamp() },
      { merge: true }
    );
    alert('Tablero creado/actualizado. ¡Listo!');
  }catch(e){
    console.error(e);
    alert('No se pudo crear el tablero: '+e.message);
  }
}


