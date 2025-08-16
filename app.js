// app.js v11 — login demo con PIN + abortar ciclo + timeline Gantt (cero en primer “from”)
// Requiere: <script src="https://cdn.jsdelivr.net/npm/chart.js"></script> antes de app.js
import { db, auth } from './firebase-config.js';
import {
  doc, getDoc, onSnapshot, runTransaction, setDoc,
  collection, orderBy, query, limit, serverTimestamp,
  where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged, signInAnonymously, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

let cycleChart = null, unsubCycles = null;

const BOARD_ID = 'llenadora';

// Escala del timeline (ancho proporcional al tiempo)
const PX_PER_MIN   = 40;   // píxeles por minuto
const MIN_CANVAS_W = 700;  // ancho mínimo px

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

let USER=null, ROLE=null, currentState='sin_solicitud';
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
    renderStepper();
    renderActions();
    estadoLabel.textContent = labelFromKey(currentState);
  });

  // ---- Logs (con metadatos) ----
  const qLogs = query(
    collection(db, 'tableros', BOARD_ID, 'logs'),
    orderBy('ts', 'desc'),
    limit(200)
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

    snap.forEach(docSnap => {
      const item = docSnap.data();
      const when = formatTs(item.ts);
      const nota = item.note ? ' · Nota: ' + escapeHtml(item.note) : '';
      const pendiente = (docSnap.metadata?.hasPendingWrites || snap.metadata?.hasPendingWrites)
        ? ' (pendiente)'
        : '';

      const row = document.createElement('div');
      row.className = 'log-item';
      row.innerHTML = `
        <time title="${TZ}${pendiente}">${when}</time>
        <div><strong>${prettyRole(item.role)}</strong> → <em>${item.action}</em>
        · Estado: <strong>${labelFromKey(item.to)}</strong>${nota}</div>`;
      logList.appendChild(row);
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
}

// Todos los pasos activos en ROJO (parpadeo lo da el CSS)
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

  // 👉 Botón ABORTAR (solo Operación y si no estamos en el inicio)
  if (ROLE === 'operacion' && currentState !== 'sin_solicitud') {
    const abortBtn = document.createElement('button');
    abortBtn.className = 'btn';
    abortBtn.style.background = 'var(--fail)';
    abortBtn.style.color = '#fff';
    abortBtn.textContent = 'Abortar ciclo (volver a 0)';
    abortBtn.onclick = abortCycle;
    actionsBox.appendChild(abortBtn);
  }
}

function stateIndex(key){ return STATES.findIndex(s=>s.key===key); }
function labelFromKey(key){ const s=STATES.find(x=>x.key===key); return s? s.label: key; }
function prettyRole(r){ return r==='operacion'?'Operación':(r==='elaboracion'?'Elaboración':(r==='materias'?'Materias Primas':String(r))); }
function escapeHtml(s){ const map={ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }; return String(s).replace(/[&<>"']/g,m=>map[m]); }
function canTransition(role, from, to){ const opts=(TRANSITIONS[role]&&TRANSITIONS[role][from])||[]; return opts.some(o=>o.to===to); }

// ---------- Transición + cierre de ciclo + resumen ----------
async function applyTransition(nextKey, actionLabel){
  if(!USER||!ROLE) return;
  if(!canTransition(ROLE, currentState, nextKey)){ alert('Transición no permitida para tu sector.'); return; }

  const note=(notaInput?.value||'').trim();
  const boardRef = doc(db,'tableros',BOARD_ID);
  const logsCol  = collection(db, 'tableros', BOARD_ID, 'logs');
  const logRef   = doc(logsCol); // ID auto

  let cycleUsed = null;

  try{
    await runTransaction(db, async (tx)=>{
      const snap = await tx.get(boardRef);
      if(!snap.exists()) throw new Error('El tablero no está inicializado.');
      const cur   = snap.data().current;
      const cycle = snap.data().cycle || 1;
      cycleUsed   = cycle;

      if(!canTransition(ROLE, cur, nextKey)) throw new Error('El estado cambió; actualizá.');

      // Estado
      tx.update(boardRef, {
        current: nextKey,
        updatedAt: serverTimestamp(),
        ...(nextKey === 'produccion_ok' ? { cycle: cycle + 1 } : {})
      });

      // Log (mismo commit)
      tx.set(logRef, {
        ts: serverTimestamp(),
        uid: (auth.currentUser?.uid)||'anon',
        role: ROLE,
        from: cur,
        to: nextKey,
        action: actionLabel,
        note,
        cycle
      });
    });

    if(notaInput) notaInput.value='';

    // Si cerramos ciclo, calcular y guardar resumen
    if (nextKey === 'produccion_ok' && cycleUsed != null) {
      await computeAndSaveTaskTimelineSummary(cycleUsed);
    }

  }catch(e){
    console.error(e);
    alert('No se pudo aplicar: ' + e.message);
  }
}

// ---------- ABORTAR CICLO ----------
async function abortCycle(){
  if(!USER || ROLE !== 'operacion') return;
  if(currentState === 'sin_solicitud') return;

  const motivo = prompt('⚠️ Vas a ABORTAR el ciclo actual y volver a 0.\nOpcional: escribí un motivo.');
  if(motivo === null) return; // canceló

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

      // Estado → inicio y ciclo+1
      tx.update(boardRef, {
        current: 'sin_solicitud',
        updatedAt: serverTimestamp(),
        cycle: cycle + 1
      });

      // Log del aborto (queda en el ciclo que cerramos)
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

    // Resumen del ciclo abortado
    if (cycleUsed != null) {
      await computeAndSaveTaskTimelineSummary(cycleUsed, { aborted: true, abortReason: motivo||'' });
    }
  }catch(e){
    console.error(e);
    alert('No se pudo abortar: ' + e.message);
  }
}

// ---------- Resumen tipo timeline (pares inicio→fin) ----------
function msToMin(ms){ return Math.round((ms/60000)*100)/100; }

async function computeAndSaveTaskTimelineSummary(cycleId, extraMeta = {}){
  // Traer logs del ciclo y ordenar en cliente (sin índices)
  const qLogs = query(
    collection(db, 'tableros', BOARD_ID, 'logs'),
    where('cycle', '==', cycleId)
  );
  const snap = await getDocs(qLogs);
  if (snap.empty) return;

  const logs = [];
  snap.forEach(d => logs.push({ id:d.id, ...d.data() }));
  logs.sort((a,b) => a.ts.toDate() - b.ts.toDate()); // asc

  // Definición de pares (inicio → fin)
  const PAIRS = [
    { from:'cip_solicitado',   to:'cip_en_curso',     label:'Demora inicio CIP',         color:'#f59e0b' },
    { from:'cip_en_curso',     to:'hisopado_pend',    label:'Duración CIP',              color:'#2563eb' },
    { from:'hisopado_pend',    to:'hisopado_en_curso',label:'Demora inicio hisopado',    color:'#f59e0b' },
    { from:'hisopado_en_curso',to:'hisopado_ok',      label:'Duración hisopado',         color:'#16a34a' },
    { from:'hisopado_ok',      to:'arranque_en_curso',label:'Demora inicio arranque',    color:'#f59e0b' },
    { from:'arranque_en_curso',to:'produccion_ok',    label:'Duración arranque',         color:'#7c3aed' }
  ];

  // Cero de la timeline = primer evento 'from' que aparezca; si no, el primer log
  const firstFromIdx = logs.findIndex(lg => PAIRS.some(p => lg.to === p.from));
  const t0 = (firstFromIdx !== -1)
    ? logs[firstFromIdx].ts.toDate().getTime()
    : logs[0].ts.toDate().getTime();

  // Múltiples segmentos por par (si hubo re-trabajo)
  const segments = []; // [{key,label,startMin,endMin,color}]
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
        segments.push({
          key: `${p.from}->${p.to}`,
          label: p.label,
          startMin, endMin,
          color: p.color
        });
        waiting[i] = null;
      }
    }
  }

  const pairs = PAIRS.map((p,i)=>({
    key:`${p.from}->${p.to}`, label:p.label, ms:accMs[i], min:msToMin(accMs[i])
  }));

  const meta = {
    cycle: cycleId,
    startedAt: logs[0].ts,
    finishedAt: logs[logs.length-1].ts,
    totalMin: Math.round(pairs.reduce((a,b)=>a+b.min,0)*100)/100,
    createdAt: serverTimestamp()
  };

  const ref = doc(db, 'tableros', BOARD_ID, 'cycles', String(cycleId));
  await setDoc(ref, { pairs, segments, ...meta, ...extraMeta });

  renderCycleChart({ pairs, segments, ...meta, ...extraMeta });
}

// ---------- Gráfico Timeline (floating bars) ----------
function renderCycleChart(summary){
  const el = chartCanvas;
  if (!el) return;

  if (typeof Chart === 'undefined') {
    console.warn('Chart.js no está cargado. Agregá <script src="https://cdn.jsdelivr.net/npm/chart.js"></script> antes de app.js');
    return;
  }

  if (cycleChart) { cycleChart.destroy(); cycleChart = null; }

  // Ajuste de ancho proporcional a la duración
  const container = el.parentElement;
  container.style.overflowX = 'auto';

  let totalSpanMin = 0;
  if (summary?.segments?.length) {
    totalSpanMin = Math.max(...summary.segments.map(s => s.endMin));
  } else if (summary?.pairs?.length) {
    totalSpanMin = summary.pairs.reduce((acc, p) => acc + (p.min || 0), 0);
  }
  const desiredPx = Math.max(MIN_CANVAS_W, Math.ceil(totalSpanMin * PX_PER_MIN));
  el.style.width  = desiredPx + 'px';
  el.style.height = '100%';

  const xSuggestedMax = Math.max(0, Math.ceil(totalSpanMin * 1.05));

  if (summary?.segments?.length){
    const labels = Array.from(new Set(summary.segments.map(s => s.label)));

    const datasets = summary.segments.map(seg => ({
      label: seg.label,
      stack: 'timeline',
      data: labels.map(lbl => lbl === seg.label ? [seg.startMin, seg.endMin] : null),
      backgroundColor: seg.color,
      borderColor: seg.color,
      borderWidth: 0,
      borderSkipped: false
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
            stacked: false,
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

  // Fallback si no hay segments
  if (summary?.pairs?.length){
    const labels = summary.pairs.filter(x => x.min > 0).map(x => x.label);
    const dataMin = summary.pairs.filter(x => x.min > 0).map(x => x.min);

    cycleChart = new Chart(el.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: [{ label:`Duración por tarea (ciclo ${summary.cycle})`, data: dataMin }] },
      options: {
        indexAxis: 'y',
        responsive:true,
        maintainAspectRatio:false,
        scales: {
          x: { beginAtZero:true, min:0, suggestedMax:xSuggestedMax, title:{ display:true, text:'min' } }
        },
        plugins: { legend:{ display:false } }
      }
    });
  }
}

// ---------- Crear tablero (con ciclo=1) ----------
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
