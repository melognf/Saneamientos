// app.js — DEMO con Firebase Anonymous + PIN de sector (tiempo real)
import { db, auth } from './firebase-config.js';
import {
  doc, getDoc, onSnapshot, runTransaction,
  collection, addDoc, orderBy, query, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  onAuthStateChanged, signInAnonymously, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ======= Constantes =======
const BOARD_ID = 'llenadora';

const STATES = [
  { key:'sin_solicitud', label:'Sin solicitud de CIP' },
  { key:'cip_solicitado', label:'CIP solicitado por Operación' },
  { key:'cip_en_curso', label:'CIP en curso (Elaboración)' },
  { key:'hisopado_pend', label:'CIP finalizado: hisopado pendiente'},
  { key:'hisopado_en_curso', label:'Hisopado en curso (Materias)' },
  { key:'hisopado_ok', label:'Hisopado OK (Listo para arranque)' },
  { key:'arranque_en_curso', label:'Arranque en curso' },
  { key:'produccion_ok', label:'Producción OK' }
];

const TRANSITIONS = {
  operacion: {
    sin_solicitud: [ {to:'cip_solicitado', action:'Solicitar CIP'} ],
    hisopado_ok:   [ {to:'arranque_en_curso', action:'Iniciar arranque'} ],
    arranque_en_curso: [ {to:'produccion_ok', action:'Confirmar producción OK'} ],
    produccion_ok: [ {to:'sin_solicitud', action:'Nuevo cambio de sabor'} ]
  },
  elaboracion: {
    cip_solicitado: [ {to:'cip_en_curso', action:'Iniciar CIP'} ],
    cip_en_curso:   [ {to:'hisopado_pend', action:'Finalizar CIP (pedir hisopado)'} ]
  },
  materias: {
    hisopado_pend:     [ {to:'hisopado_en_curso', action:'Iniciar hisopado'} ],
    hisopado_en_curso: [ {to:'hisopado_ok', action:'Aprobar (OK)'}, {to:'cip_solicitado', action:'Rechazar (re-CIP)'} ]
  }
};

// ======= Estado =======
let USER = null;
let ROLE = null;
let currentState = 'sin_solicitud';

let unsubBoard = null;
let unsubLogs = null;

// ======= UI refs =======
const loginBox  = document.getElementById('loginBox');
const loggedBox = document.getElementById('loggedBox');
const roleBadge = document.getElementById('roleBadge');
const roleName  = document.getElementById('roleName');
const roleHint  = document.getElementById('roleHint');
const logoutBtn = document.getElementById('logout');

const sectorSel = document.getElementById('sector');
const pinInput  = document.getElementById('pin');
const btnLogin  = document.getElementById('btnLogin');

const estadoLabel = document.getElementById('estadoLabel');
const stepperBox  = document.getElementById('stepper');
const actionsBox  = document.getElementById('actions');
const logList     = document.getElementById('logList');
const notaInput   = document.getElementById('nota');

// ======= DEMO Login (Anonymous + PIN) =======
btnLogin?.addEventListener('click', () => doLogin());
pinInput?.addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
logoutBtn?.addEventListener('click', () => signOut(auth));

async function doLogin(){
  const role = sectorSel.value;
  const pin  = (pinInput?.value||'').trim();
  if(!pin){ alert('Ingresá el PIN del sector'); return; }

  try{
    const cred = await signInAnonymously(auth);
    const uid = cred.user.uid;

    // Revisar si ya tiene rol asignado
    const uref = doc(db, 'users', uid);
    const usnap = await getDoc(uref);
    if(!usnap.exists()){
      // Intentar crear el doc de usuario con rol + pin (las reglas validan el PIN contra /demo/{role})
      await runTransaction(db, async (tx) => {
        tx.set(uref, {
          role, pin, createdAt: serverTimestamp()
        });
      });
    }
    pinInput.value='';
  }catch(e){
    console.error(e);
    alert('No se pudo iniciar: ' + e.message);
  }
}

onAuthStateChanged(auth, async (user) => {
  USER = user || null;
  if(!USER){
    ROLE = null;
    teardownSubs();
    render();
    return;
  }
  // Leer rol desde users/{uid}
  const uref = doc(db, 'users', USER.uid);
  const usnap = await getDoc(uref);
  ROLE = usnap.exists() ? (usnap.data().role || null) : null;
  render();
  setupSubs();
});

function setupSubs(){
  const bref = doc(db, 'tableros', BOARD_ID);
  unsubBoard = onSnapshot(bref, snap => {
    if(!snap.exists()){
      estadoLabel.textContent = 'Sin inicializar (crear doc tableros/llenadora)';
      return;
    }
    const data = snap.data();
    currentState = data.current || 'sin_solicitud';
    renderStepper();
    renderActions();
    estadoLabel.textContent = labelFromKey(currentState);
  });

  const q = query(collection(db, 'tableros', BOARD_ID, 'logs'), orderBy('ts','desc'), limit(200));
  unsubLogs = onSnapshot(q, snap => {
    logList.innerHTML='';
    if(snap.empty){
      const empty=document.createElement('div');
      empty.style.opacity=.7; empty.textContent='Sin movimientos aún.';
      logList.appendChild(empty);
      return;
    }
    snap.forEach(docSnap => {
      const item = docSnap.data();
      const row=document.createElement('div');
      row.className='log-item';
      const ts = item.ts?.toDate ? item.ts.toDate() : new Date();
      const nota = item.note ? ' · Nota: '+escapeHtml(item.note) : '';
      row.innerHTML = `<time>${ts.toLocaleString()}</time>
        <div><strong>${prettyRole(item.role)}</strong> → <em>${item.action}</em> · Estado: <strong>${labelFromKey(item.to)}</strong>${nota}</div>`;
      logList.appendChild(row);
    });
  });
}

function teardownSubs(){
  if(unsubBoard){ unsubBoard(); unsubBoard=null; }
  if(unsubLogs){ unsubLogs(); unsubLogs=null; }
}

// ======= Render =======
function render(){
  if(USER && ROLE){
    loginBox.style.display='none';
    loggedBox.style.display='block';
    roleBadge.hidden=false;
    roleName.textContent = prettyRole(ROLE);
    roleHint.textContent = USER.isAnonymous ? 'Anon demo' : 'activo';
  }else{
    loginBox.style.display='flex';
    loggedBox.style.display='none';
    roleBadge.hidden=true;
  }
  renderStepper();
  renderActions();
  estadoLabel.textContent = labelFromKey(currentState);
}

function renderStepper(){
  stepperBox.innerHTML='';
  const curIdx = stateIndex(currentState);
  STATES.forEach((s,idx)=>{
    const el=document.createElement('div');
    el.className='step';
    if(idx<curIdx) el.classList.add('done');
    if(idx===curIdx) el.classList.add('active');
    el.innerHTML=`<div class="dot"></div><div style="font-size:12px">${idx+1}. ${s.label}</div>`;
    stepperBox.appendChild(el);
  });
}

function renderActions(){
  actionsBox.innerHTML='';
  if(!USER || !ROLE){ return; }
  const opts = (TRANSITIONS[ROLE] && TRANSITIONS[ROLE][currentState]) || [];
  if(!opts.length){
    const none = document.createElement('div');
    none.style.opacity=.75;
    none.textContent = 'Sin acciones disponibles para tu sector en este estado.';
    actionsBox.appendChild(none);
  }else{
    for(const op of opts){
      const b=document.createElement('button');
      b.className='btn primary row';
      b.textContent=op.action;
      b.addEventListener('click',()=>applyTransition(op.to, op.action));
      actionsBox.appendChild(b);
    }
  }
}

// ======= Helpers =======
function stateIndex(key){ return STATES.findIndex(s=>s.key===key); }
function labelFromKey(key){ const s=STATES.find(x=>x.key===key); return s?s.label:key; }
function prettyRole(r){ return r==='operacion'?'Operación':(r==='elaboracion'?'Elaboración':(r==='materias'?'Materias Primas':String(r))); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function canTransition(role, from, to){
  const opts = (TRANSITIONS[role] && TRANSITIONS[role][from]) || [];
  return opts.some(o=>o.to===to);
}

// ======= Acción: transición con transacción + log =======
async function applyTransition(nextKey, actionLabel){
  if(!USER || !ROLE) return;
  if(!canTransition(ROLE, currentState, nextKey)){
    alert('Transición no permitida para tu sector.');
    return;
  }
  const note = (notaInput?.value||'').trim();
  const boardRef = doc(db,'tableros', BOARD_ID);
  const logsCol  = collection(db, 'tableros', BOARD_ID, 'logs');

  try{
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(boardRef);
      if(!snap.exists()){
        throw new Error('El tablero no está inicializado. Creá tableros/llenadora.');
      }
      const current = snap.data().current;
      if(!canTransition(ROLE, current, nextKey)){
        throw new Error('El estado cambió; actualizá la página.');
      }
      tx.update(boardRef, { current: nextKey, updatedAt: serverTimestamp() });
      await addDoc(logsCol, {
        ts: serverTimestamp(),
        uid: USER.uid,
        role: ROLE,
        from: current,
        to: nextKey,
        action: actionLabel,
        note
      });
    });
    if(notaInput) notaInput.value='';
  }catch(e){
    console.error(e);
    alert('No se pudo aplicar: ' + e.message);
  }
}

// Atajo: Enter envía primera acción
notaInput?.addEventListener('keydown', e=>{
  if(e.key==='Enter'){
    const btn = actionsBox.querySelector('button');
    if(btn) btn.click();
  }
});
