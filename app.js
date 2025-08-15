// app.js v4 — mensajes claros y render inmediato
import { db, auth } from './firebase-config.js';
import {
  doc, getDoc, onSnapshot, runTransaction, setDoc,
  collection, addDoc, orderBy, query, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  onAuthStateChanged, signInAnonymously, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

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
    arranque_en_curso: [
      {to:'produccion_ok', action:'Confirmar producción OK'},
      {to:'sin_solicitud', action:'Cancelar y reiniciar'}
    ],
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

let USER = null;
let ROLE = null;
let currentState = 'sin_solicitud';

let unsubBoard = null;
let unsubLogs = null;

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
const initBox     = document.getElementById('initBox');
const btnInitBoard= document.getElementById('btnInitBoard');

btnInitBoard?.addEventListener('click', async ()=>{
  try{
    await setDoc(doc(db, 'tableros', 'llenadora'), { current: 'sin_solicitud', updatedAt: serverTimestamp() });
    alert('Tablero creado. ¡Listo para usar!');
  }catch(e){
    console.error(e);
    alert('No se pudo crear el tablero: ' + e.message + '\nRevisá las reglas de Firestore.');
  }
});

btnLogin?.addEventListener('click', () => doLogin());
pinInput?.addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
logoutBtn?.addEventListener('click', () => signOut(auth));

async function doLogin(){
  const role = sectorSel.value;
  const pin  = (pinInput?.value||'').trim();
  if(!pin){ alert('Ingresá el PIN del sector'); return; }

  sessionStorage.setItem('pending_role', role);
  sessionStorage.setItem('pending_pin', pin);

  try{
    if(!auth.currentUser){ await signInAnonymously(auth); }
    const uid = auth.currentUser.uid;
    const uref = doc(db, 'users', uid);

    let usnap;
    try{ usnap = await getDoc(uref); }
    catch(e){
      console.error('Error leyendo users/{uid}:', e);
      alert('Error de permisos al leer tu usuario. Revisá Rules: match /users/{uid} allow read si uid coincide.');
      return;
    }

    if(!usnap.exists()){
      try{
        await runTransaction(db, async (tx) => { tx.set(uref, { role, pin, createdAt: serverTimestamp() }); });
      }catch(e){
        console.error('Error creando users/{uid}:', e);
        if(String(e).includes('PERMISSION_DENIED')){
          alert('Permiso denegado al crear usuario. Verificá:\n• demo/'+role+' con pin STRING "'+pin+'";\n• Rules publicadas;\n• La colección se llama "users".');
        }else{
          alert('No se pudo crear el usuario: ' + e.message);
        }
        return;
      }
      usnap = await getDoc(uref);
    }

    ROLE = usnap.exists() ? (usnap.data().role||null) : null;
    if(!ROLE){ alert('No se pudo asignar rol. Revisá demo/* y Rules.'); return; }

    pinInput.value='';
    render();
    setupSubs();

  }catch(err){
    console.error(err);
    if(err.code === 'auth/admin-restricted-operation' || err.code === 'auth/operation-not-allowed'){
      alert('Activá Authentication → Sign-in method → Anonymous y guardá.');
    }else{
      alert('No se pudo iniciar: ' + err.message);
    }
  }
}

onAuthStateChanged(auth, async (user) => {
  USER = user || null;
  if(!USER){
    ROLE = null; teardownSubs(); render(); return;
  }
  try{
    const uref = doc(db, 'users', USER.uid);
    let usnap = await getDoc(uref);
    if(!usnap.exists()){
      const role = sessionStorage.getItem('pending_role');
      const pin  = sessionStorage.getItem('pending_pin');
      if(role && pin){
        try{ await runTransaction(db, async (tx)=>{ tx.set(uref, { role, pin, createdAt: serverTimestamp() }); }); }
        catch(e){ console.error('Tx en onAuthStateChanged falló:', e); }
        usnap = await getDoc(uref);
      }
    }
    ROLE = usnap.exists() ? (usnap.data().role||null) : null;
  }catch(err){ console.error(err); }
  render();
  setupSubs();
});

function setupSubs(){
  const bref = doc(db, 'tableros', 'llenadora');
  if(unsubBoard) unsubBoard();
  unsubBoard = onSnapshot(bref, snap => {
    if(!snap.exists()){
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

  const q = query(collection(db, 'tableros', 'llenadora', 'logs'), orderBy('ts','desc'), limit(200));
  if(unsubLogs) unsubLogs();
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

function teardownSubs(){ if(unsubBoard){ unsubBoard(); unsubBoard=null; } if(unsubLogs){ unsubLogs(); unsubLogs=null; } }

function render(){
  if(USER && ROLE){
    loginBox.style.display='none'; loggedBox.style.display='block'; roleBadge.hidden=false;
    roleName.textContent = prettyRole(ROLE); roleHint.textContent = USER.isAnonymous ? 'Anon demo' : 'activo';
  }else{
    loginBox.style.display='flex'; loggedBox.style.display='none'; roleBadge.hidden=true;
  }
  renderStepper(); renderActions(); estadoLabel.textContent = labelFromKey(currentState);
}

function renderStepper(){
  stepperBox.innerHTML='';
  const curIdx = stateIndex(currentState);
  STATES.forEach((s,idx)=>{
    const el=document.createElement('div'); el.className='step';
    if(idx<curIdx) el.classList.add('done'); if(idx===curIdx) el.classList.add('active');
    el.innerHTML=`<div class="dot"></div><div style="font-size:12px">${idx+1}. ${s.label}</div>`; stepperBox.appendChild(el);
  });
}

function renderActions(){
  actionsBox.innerHTML='';
  if(!USER || !ROLE){ return; }
  const opts = (TRANSITIONS[ROLE] && TRANSITIONS[ROLE][currentState]) || [];
  if(!opts.length){
    const none = document.createElement('div'); none.style.opacity=.75; none.textContent = 'Sin acciones disponibles para tu sector en este estado.'; actionsBox.appendChild(none);
  }else{
    for(const op of opts){
      const b=document.createElement('button'); b.className='btn primary row'; b.textContent=op.action; b.addEventListener('click',()=>applyTransition(op.to, op.action)); actionsBox.appendChild(b);
    }
  }
}

function stateIndex(key){ return STATES.findIndex(s=>s.key===key); }
function labelFromKey(key){ const s=STATES.find(x=>x.key===key); return s?s.label:key; }
function prettyRole(r){ return r==='operacion'?'Operación':(r==='elaboracion'?'Elaboración':(r==='materias'?'Materias Primas':String(r))); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function canTransition(role, from, to){ const opts=(TRANSITIONS[role]&&TRANSITIONS[role][from])||[]; return opts.some(o=>o.to===to); }

async function applyTransition(nextKey, actionLabel){
  if(!USER || !ROLE) return;
  if(!canTransition(ROLE, currentState, nextKey)){ alert('Transición no permitida para tu sector.'); return; }
  const note = (notaInput?.value||'').trim();
  const boardRef = doc(db,'tableros','llenadora');
  const logsCol  = collection(db, 'tableros', 'llenadora', 'logs');

  try{
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(boardRef);
      if(!snap.exists()){ throw new Error('El tablero no está inicializado. Creá tableros/llenadora.'); }
      const current = snap.data().current;
      if(!canTransition(ROLE, current, nextKey)){ throw new Error('El estado cambió; actualizá la página.'); }
      tx.update(boardRef, { current: nextKey, updatedAt: serverTimestamp() });
      await addDoc(logsCol, { ts: serverTimestamp(), uid:(auth.currentUser?.uid)||'anon', role: ROLE, from: current, to: nextKey, action: actionLabel, note });
    });
    if(notaInput) notaInput.value='';
  }catch(e){ console.error(e); alert('No se pudo aplicar: ' + e.message); }
}
