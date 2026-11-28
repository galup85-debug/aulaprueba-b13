import {readPDF,parsePDFExam} from './pdf-import.js?v=5.5';
import {DEFAULT_DIMENSIONS,dimensionsOf,tagsOf,categoriesFrom,analyze,feedback,parseSpecificationTable,scoreItem,generateGoogleScript} from './pedagogia.js?v=5.2';
/* AulaPrueba B-13 — interfaz navegador. El modo demostración es local y NO comparte datos entre dispositivos. */
const $ = s => document.querySelector(s);
const app = $('#app');
const cfg = window.APP_CONFIG || {};
const isDemo = !(cfg.supabaseUrl && cfg.publishableKey);
let supa = null;
let refreshTimer = null, studentTimer = null, heartbeatTimer = null, realtime = null;
let toastTimer = null, studentBusy = false;
let studentLoad = null, studentAnswers = new Map(), pendingTimers = new Map(), inFlight = new Map();
let serverClockOffset = 0;
let pedagogy={dimensions:[...DEFAULT_DIMENSIONS],specifications:[],ready:null};
let pedagogicalGrades=[],pedagogicalFilter='',pedagogicalStudent='',pedagogicalLow=60,pedagogicalHigh=80,pedagogicalLessonMinutes=60;
let studentQuestionIndex = 0, studentNavigating = false;
const state = {view:'home', teacher:null, exams:[], exam:null, questions:[], draft:[], snapshot:null, activeStudent:null, loginMode:'signin', selectedStudent:null, joinCode:'', importText:'', announcedIds:new Set()};
const el = (tag,attrs={},txt='')=>{const e=document.createElement(tag);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v));e.textContent=txt;return e};
let deadlineSubmissionAttempted = false;
const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => typeof crypto.randomUUID==='function' ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{const a=new Uint8Array(1);crypto.getRandomValues(a);const v=c==='x' ? a[0]&15 : (a[0]&3)|8;return v.toString(16)});
const code = () => { const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789', a=new Uint8Array(7);crypto.getRandomValues(a);return [...a].map(v=>alphabet[v%alphabet.length]).join(''); };
const fmt = t=>t ? new Date(t).toLocaleString('es-CL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const iso = () => new Date().toISOString();
const num = n=>Number(n||0).toLocaleString('es-CL',{maximumFractionDigits:2});
const wait = ms=>new Promise(r=>setTimeout(r,ms));
const validEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email??'')) && String(email).length<=254;
const validFullName = name => /\S+\s+\S+/.test(String(name??'').trim());
const validCourse = curso => String(curso??'').trim().length >= 2 && String(curso??'').trim().length <= 45;
const validListNumber = numero => Number.isInteger(Number(numero)) && Number(numero)>=1 && Number(numero)<=100;
const safeSession = key => {try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}};
let wasFullscreen = false;
function isExamInProgress(){return state.view==='student-exam'&&!!state.activeStudent&&!studentLoad?.participant.submitted_at;}
async function askFullscreen(){
 if(document.fullscreenElement)return true;
 if(!document.fullscreenEnabled||!document.documentElement.requestFullscreen)return false;
 try{await document.documentElement.requestFullscreen();return true}
 catch(e){console.info('Pantalla completa no autorizada en este dispositivo',e);return false}
}
function fullscreenBanner(){
 const banner=$('#fullscreen-banner');if(!banner)return;
 const full=!!document.fullscreenElement;
 banner.classList.toggle('hidden',full);
 const status=$('#fullscreen-status');if(status)status.textContent=full?'Pantalla completa activa':'Pantalla completa no activa';
}
function emailReport(student,snap=state.snapshot,exam=state.exam){
 const score=scoring(student,snap,state.questions);
 const answered=snap.answers.filter(a=>a.participant_id===student.id).length;
 const summary=`AulaPrueba B-13\nEvaluación: ${exam.title}\nEstudiante: ${student.name}\n\n`+
  `Curso: ${student.curso||'No registrado'} · N.º de lista: ${student.numero_lista??'No registrado'}\n`+
  `Preguntas respondidas: ${answered} de ${state.questions.length}\n`+
  `Puntaje de selección corregido automáticamente: ${num(score.auto)} de ${num(score.max)} puntos\n`+
  (score.open?`Preguntas abiertas pendientes de corrección docente: ${score.open}\n`:'')+
  `Entrega: ${fmt(student.submitted_at)}\n\n`+supervisionText(student,snap)+'\n\n'+
  `Este informe corresponde exclusivamente a la corrección automática disponible. No equivale necesariamente a la calificación final.\n`+
  `Reenviado por el profesor desde AulaPrueba B-13.`;
 return {subject:`Resultado de ${exam.title} — AulaPrueba B-13`,text:summary};
}
function prepareMail(id){
 const student=state.snapshot?.students.find(x=>x.id===id);
 if(!student?.email||!validEmail(student.email))throw Error('Este estudiante no tiene un correo electrónico válido.');
 if(!student.submitted_at)throw Error('El estudiante todavía no ha entregado la prueba.');
 const info=emailReport(student);
 window.location.href=`mailto:${encodeURIComponent(student.email)}?subject=${encodeURIComponent(info.subject)}&body=${encodeURIComponent(info.text)}`;
 toast('Se preparó el correo en tu aplicación de correo. Revisa y presiona Enviar allí.');
}
async function sendMail(id){
 if(isDemo)throw Error('El envío directo solo está disponible con Supabase y la función de correo activada. Puedes preparar un correo manual.');
 const student=state.snapshot?.students.find(x=>x.id===id);
 if(!student?.email||!validEmail(student.email))throw Error('El alumno no tiene un correo válido.');
 if(!student.submitted_at)throw Error('Es necesario que el estudiante entregue antes de enviar resultados.');
 if(!confirm(`¿Enviar el resultado automático de ${student.name} a ${student.email}? El correo no ha sido verificado y podría contener una dirección incorrecta. Verifica antes de continuar.`))return;
 const response=await supa.functions.invoke('enviar-resultado',{body:{exam_id:state.exam.id,participant_id:id}});
 if(response.error)throw Error('No fue posible enviar el correo. Revisa la configuración de la función de Supabase y el proveedor de email. '+(response.error.message||''));
 if(!response.data?.ok)throw Error(response.data?.error||'El proveedor no confirmó el envío');
 toast('Solicitud de envío aceptada por el proveedor de correo. Comprueba su entrega en el servicio de correo.',6000);
}

function toast(message,ms=3500){const t=$('#toast');t.textContent=String(message);t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),ms)}
function err(e){console.error(e);toast(e?.message||String(e),5500)}
function check(result){if(result.error)throw result.error;return result.data}
function stopUpdates(){clearInterval(refreshTimer);clearInterval(studentTimer);clearInterval(heartbeatTimer);refreshTimer=studentTimer=heartbeatTimer=null;if(realtime&&supa){supa.removeChannel(realtime);realtime=null}}
function setView(view){stopUpdates();state.view=view;if(!['student-join','student-exam'].includes(view)&&document.fullscreenElement)document.exitFullscreen().catch(()=>{});$('#home-btn').classList.toggle('hidden',view==='student-join');$('#logout-btn').classList.toggle('hidden',!(state.teacher&&!isDemo&&['teacher-list','editor','dashboard','pedagogy'].includes(view)));}
function viewHome(){if(isExamInProgress()){if(!confirm('¿Salir de la evaluación? Se registrará una incidencia de salida. Podrás volver a ingresar con tus datos si la prueba sigue abierta.'))return;void studentEvent('pagehide')}studentEntrance();}

// La portada pública conduce exclusivamente al ingreso de estudiantes.

/* ============================ DATOS ============================ */
const demoKey='aulapruebas38_v1';
function db(){const data=JSON.parse(localStorage.getItem(demoKey)||'null');if(data)return data;
 const exam={id:uid(),teacher_id:'demo',title:'Prueba de demostración',description:'Esta evaluación permite comprobar el ingreso, las respuestas y el registro de cambios de pestaña.',code:'DEMO38',duration_minutes:30,status:'published',created_at:iso()};
 const qs=[{id:uid(),exam_id:exam.id,position:0,kind:'single',prompt:'¿Cuál de las siguientes alternativas corresponde a un texto dramático?',options:['Un guion teatral','Una noticia','Un instructivo','Una carta formal'],correct:[0],points:1},
 {id:uid(),exam_id:exam.id,position:1,kind:'multi',prompt:'Selecciona los elementos que pueden formar parte de una obra teatral.',options:['Acotaciones','Diálogos','Titulares periodísticos','Escenas'],correct:[0,1,3],points:2},
 {id:uid(),exam_id:exam.id,position:2,kind:'short',prompt:'Explica brevemente qué función cumplen las acotaciones en una obra dramática.',options:[],correct:[],points:2}];
 const d={exams:[exam],questions:qs,students:[],answers:[],events:[]};localStorage.setItem(demoKey,JSON.stringify(d));return d;}
function putDb(d){localStorage.setItem(demoKey,JSON.stringify(d));}
const copy = o=>structuredClone(o);
async function teacherExams(){if(isDemo)return copy(db().exams).sort((a,b)=>b.created_at.localeCompare(a.created_at));return check(await supa.from('qx_exams').select('*').order('created_at',{ascending:false}));}
async function teacherCreate(payload){if(isDemo){const d=db(),e={...payload,id:uid(),teacher_id:'demo',created_at:iso()};if(d.exams.some(x=>x.code===e.code))throw Error('Código repetido');d.exams.push(e);putDb(d);return copy(e)}return check(await supa.from('qx_exams').insert({...payload,teacher_id:state.teacher.id}).select().single());}
async function teacherUpdate(exam,patch){if(isDemo){const d=db(),e=d.exams.find(e=>e.id===exam.id);Object.assign(e,patch);putDb(d);return copy(e)}return check(await supa.from('qx_exams').update(patch).eq('id',exam.id).select().single());}
function missingPedagogy(error){return ['42P01','42883','PGRST202','PGRST205'].includes(error?.code)}
async function loadPedagogy(exam){
 if(isDemo)return {dimensions:[...DEFAULT_DIMENSIONS],specifications:[],ready:true};
 const res=await supa.from('qx_pedagogy').select('dimensions,specifications').eq('exam_id',exam.id).maybeSingle();
 if(res.error){if(missingPedagogy(res.error))return {dimensions:[...DEFAULT_DIMENSIONS],specifications:[],ready:false};throw res.error}
 return {dimensions:dimensionsOf(res.data?.dimensions),specifications:res.data?.specifications||[],ready:true};
}
async function teacherQuestions(exam){
 if(isDemo)return copy(db().questions.filter(q=>q.exam_id===exam.id).sort((a,b)=>a.position-b.position));
 const qs=check(await supa.from('qx_questions').select('*').eq('exam_id',exam.id).order('position'));
 pedagogy=await loadPedagogy(exam);
 return qs.map((q,i)=>({...q,categories:tagsOf(pedagogy.specifications[i])}));
}
async function teacherReplaceQuestions(exam,items){if(isDemo){const d=db();d.questions=d.questions.filter(q=>q.exam_id!==exam.id);d.questions.push(...items.map((q,i)=>({...q,id:uid(),exam_id:exam.id,position:i})));putDb(d);return items.length}
 const dims=dimensionsOf(pedagogy.dimensions),specs=items.map(q=>tagsOf(q.categories));
 const base=items.map(({categories,sourceNumber,...q})=>q);
 const v5=await supa.rpc('qx_replace_questions_v5',{p_exam:exam.id,p_questions:base,p_dimensions:dims,p_specs:specs});
 if(!v5.error)return v5.data;
 if(!missingPedagogy(v5.error))throw v5.error;
 if(specs.some(r=>r.some(Boolean))||JSON.stringify(dims)!==JSON.stringify(DEFAULT_DIMENSIONS))
 throw Error('Primero activa la actualización v5.0 en Supabase para guardar las categorías. No se modificaron las preguntas.');
 return check(await supa.rpc('qx_replace_questions',{p_exam:exam.id,p_questions:base}));}
async function teacherSnapshot(exam){if(isDemo){const d=db(),students=d.students.filter(s=>s.exam_id===exam.id);return copy({students:students.map(({token,...rest})=>rest),answers:d.answers.filter(a=>students.some(s=>s.id===a.participant_id)),events:d.events.filter(e=>students.some(s=>s.id===e.participant_id)).sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at))})}
 return check(await supa.rpc('qx_teacher_snapshot',{p_exam:exam.id}));}
async function studentJoin(p_code,p_name,p_curso,p_numero_lista,p_email,p_token){
 if(isDemo){
  const d=db(),exam=d.exams.find(e=>e.code===p_code.toUpperCase());if(!exam)throw Error('Código de evaluación inexistente');
  let st=p_token&&d.students.find(x=>x.exam_id===exam.id&&x.token===p_token);
  if(st){
   if(st.name.toLowerCase()!==p_name.toLowerCase()||(st.curso&&st.curso.toLowerCase()!==p_curso.toLowerCase())||(st.numero_lista!=null&&Number(st.numero_lista)!==p_numero_lista)||st.email?.toLowerCase()!==p_email.toLowerCase())throw Error('Los datos no coinciden con esta sesión');
   st.curso=p_curso;st.numero_lista=p_numero_lista;putDb(d);
   return {exam_id:exam.id,token:st.token,name:st.name,curso:st.curso,numero_lista:st.numero_lista,email:st.email};
  }
  if(exam.status!=='published')throw Error('La prueba no está abierta');
  if(d.students.filter(x=>x.exam_id===exam.id).length>=38)throw Error('Cupo máximo de 38 estudiantes');
  if(d.students.find(x=>x.exam_id===exam.id&&(x.email?.toLowerCase()===p_email.toLowerCase()||(x.curso?.toLowerCase()===p_curso.toLowerCase()&&Number(x.numero_lista)===p_numero_lista))))throw Error('El correo o el número de lista ya están registrados en este curso. Regresa a tu navegador original.');
  st={id:uid(),exam_id:exam.id,name:p_name,curso:p_curso,numero_lista:p_numero_lista,email:p_email,token:uid(),joined_at:iso(),last_seen_at:iso(),submitted_at:null};d.students.push(st);putDb(d);
  return {exam_id:exam.id,token:st.token,name:st.name,curso:st.curso,numero_lista:st.numero_lista,email:st.email};
 }
 return check(await supa.rpc('qx_student_join_identificado',{p_code,p_name,p_curso,p_numero_lista,p_email,p_token}));
}
async function studentFetch(examId,token){if(isDemo){const d=db(),s=d.students.find(s=>s.exam_id===examId&&s.token===token);if(!s)throw Error('Sesión no encontrada');const e=d.exams.find(e=>e.id===examId);return {exam:{id:e.id,title:e.title,description:e.description,status:e.status,duration_minutes:e.duration_minutes},participant:{id:s.id,name:s.name,joined_at:s.joined_at,submitted_at:s.submitted_at,expires_at:new Date(new Date(s.joined_at).getTime()+e.duration_minutes*60000).toISOString(),server_now:iso()},questions:d.questions.filter(q=>q.exam_id===e.id).map(({correct,...rest})=>rest).sort((a,b)=>a.position-b.position),answers:d.answers.filter(a=>a.participant_id===s.id).map(({question_id,response})=>({question_id,response}))}}
 return check(await supa.rpc('qx_student_load',{p_exam:examId,p_token:token}));}
async function studentSave(qid,response){if(isDemo){const d=db(),s=d.students.find(s=>s.exam_id===state.activeStudent.exam_id&&s.token===state.activeStudent.token),ex=d.exams.find(e=>e.id===s.exam_id);if(s.submitted_at||ex.status!=='published'||Date.now()>new Date(s.joined_at).getTime()+ex.duration_minutes*60000)throw Error('Tiempo concluido o prueba cerrada');let a=d.answers.find(a=>a.participant_id===s.id&&a.question_id===qid);if(a){a.response=response;a.saved_at=iso()}else d.answers.push({participant_id:s.id,question_id:qid,response,saved_at:iso()});s.last_seen_at=iso();putDb(d);return true}return check(await supa.rpc('qx_student_save',{p_exam:state.activeStudent.exam_id,p_token:state.activeStudent.token,p_question:qid,p_response:response}));}
async function studentEvent(kind){if(!state.activeStudent||state.view!=='student-exam'||studentLoad?.participant.submitted_at)return;
 if(isDemo){const d=db(),s=d.students.find(s=>s.exam_id===state.activeStudent.exam_id&&s.token===state.activeStudent.token);if(s){d.events.push({id:Date.now()+Math.random(),participant_id:s.id,kind,occurred_at:iso()});s.last_seen_at=iso();putDb(d)}return}
 const session=state.activeStudent;try{const r=await supa.rpc('qx_student_event',{p_exam:session.exam_id,p_token:session.token,p_kind:kind});if(r.error){if(isRevokedSession(r.error))invalidateStudentSession(session);else console.warn('Evento no enviado',r.error)}}catch(e){console.warn('Evento no enviado',e)}
}
function invalidateStudentSession(session){
 if(!session||state.activeStudent?.token!==session.token||state.view!=='student-exam')return;
 try{localStorage.removeItem('qx_session_'+session.code);const pos=studentPositionKey();if(pos)localStorage.removeItem(pos)}catch(e){}
 for(const timer of pendingTimers.values())clearTimeout(timer);
 pendingTimers.clear();inFlight.clear();state.activeStudent=null;studentLoad=null;studentAnswers=new Map();studentBusy=false;
 setView('student-removed');
 app.innerHTML='<div class="narrow card"><h1>Sesión finalizada por el docente</h1><p>Este registro ya no está disponible. Si tu profesor lo autoriza y la evaluación sigue abierta, vuelve a ingresar con tus datos correctos.</p><button class="btn btn-outline" data-action="home">Volver al ingreso</button></div>';
}
function isRevokedSession(error){return /sesi[oó]n (?:no reconocida|no encontrada|inv[aá]lida)/i.test(error?.message||'')}
async function studentPing(){
 if(!state.activeStudent||state.view!=='student-exam'||studentLoad?.participant.submitted_at)return;
 const session=state.activeStudent;
 if(isDemo){const d=db(),st=d.students.find(x=>x.exam_id===session.exam_id&&x.token===session.token);if(!st){invalidateStudentSession(session);return}st.last_seen_at=iso();putDb(d);return}
 const r=await supa.rpc('qx_student_ping',{p_exam:session.exam_id,p_token:session.token});
 if(r.error){if(isRevokedSession(r.error)){invalidateStudentSession(session);return}throw r.error}
}
async function studentSubmit(){if(isDemo){const d=db(),s=d.students.find(s=>s.exam_id===state.activeStudent.exam_id&&s.token===state.activeStudent.token);s.submitted_at=s.submitted_at||iso();putDb(d);return true}return check(await supa.rpc('qx_student_submit',{p_exam:state.activeStudent.exam_id,p_token:state.activeStudent.token}));}


/* Acceso estudiantil mediante código QR único para cada evaluación. */
const examQrCache = new Map();
function examJoinUrl(exam) {
  const link = new URL(location.pathname,location.origin);
  link.searchParams.set('code',exam.code);
  return link.toString();
}
function qrImageData(exam) {
  const url = examJoinUrl(exam);
  if(examQrCache.has(url)) return examQrCache.get(url);
  if(typeof window.QRCode !== 'function') return null;
  const host = document.createElement('div');
  new window.QRCode(host,{
    text:url,width:240,height:240,colorDark:'#193040',colorLight:'#ffffff',
    correctLevel:window.QRCode.CorrectLevel.M
  });
  const canvas = host.querySelector('canvas');
  if(!canvas) return null;
  const image = canvas.toDataURL('image/png');
  examQrCache.set(url,image);
  return image;
}
function insertExamQR(exam) {
  const dashboardStats = app.querySelector('.stats');
  const editorCard = app.querySelector('.form-columns section > .card');
  if(!dashboardStats && !editorCard) return;
  const section = document.createElement('section');
  section.className = 'card exam-qr-card';
  const url = examJoinUrl(exam);
  const notPublished = exam.status !== 'published';
  section.innerHTML =
    '<div class="exam-qr-preview" id="exam-qr-preview" aria-label="Código QR de ingreso a la evaluación"></div>'+
    '<div class="exam-qr-information">'+
      '<div class="eyebrow">Ingreso estudiantil</div>'+
      '<h2>Código QR de esta evaluación</h2>'+
      '<p class="muted">Proyecta el QR en la sala o descárgalo para compartirlo. Al escanearlo, cada alumno llegará directamente al ingreso de esta prueba.</p>'+
      '<p><b>Código: '+esc(exam.code)+'</b> · Tiempo máximo: <b>'+esc(exam.duration_minutes)+' minutos</b> por estudiante.</p>'+
      (notPublished?'<p class="notice warning">Este QR será utilizable cuando publiques la evaluación.</p>':'')+
      '<div class="exam-qr-url">'+esc(url)+'</div>'+
      '<div class="btn-row">'+
        '<button type="button" class="btn btn-outline small" data-action="copy-link">Copiar enlace</button>'+
        '<button type="button" class="btn btn-green small" data-action="download-qr" id="qr-download">Descargar QR (PNG)</button>'+
      '</div>'+
    '</div>';
  if(dashboardStats) dashboardStats.before(section);
  else editorCard.after(section);
  const preview = section.querySelector('#exam-qr-preview');
  try {
    const data = qrImageData(exam);
    if(data) {
      const img = document.createElement('img');
      img.src = data;
      img.alt = 'Código QR de acceso a '+exam.title;
      img.width = 240;
      img.height = 240;
      preview.replaceChildren(img);
    } else {
      preview.textContent = 'No se pudo cargar el generador QR. Comprueba la conexión a internet; el enlace continúa disponible.';
      section.querySelector('#qr-download').disabled = true;
    }
  } catch(e) {
    console.warn('No fue posible generar el QR',e);
    preview.textContent = 'No se pudo generar el código QR. Copia el enlace de ingreso.';
    section.querySelector('#qr-download').disabled = true;
  }
}
function downloadExamQR() {
  if(!state.exam) throw Error('Primero selecciona una evaluación');
  const data = qrImageData(state.exam);
  if(!data) throw Error('No se pudo generar el QR. Comprueba que el navegador cargó el generador.');
  const link = document.createElement('a');
  link.href = data;
  link.download = 'AulaPrueba-B13-QR-'+state.exam.code+'.png';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/* ========================== PROFESOR =========================== */
function teacherEntrance(){if(isDemo){setView('teacher-unavailable');app.innerHTML='<div class="narrow card"><h1>Panel docente no disponible</h1><p>La página todavía no está conectada a Supabase. Por seguridad, el panel del profesor no se habilita en la demostración pública.</p><p>Configura Supabase y autoriza el correo docente antes de administrar evaluaciones.</p><button class="btn btn-outline" data-action="home">Volver al ingreso estudiantil</button></div>';return}if(state.teacher)return teacherList();return teacherLogin()}
function teacherLogin(){setView('login');app.innerHTML=`<div class="narrow"><section class="hero"><div class="eyebrow">Acceso docente</div><h1>Panel del profesor</h1><p>Ingresa sin contraseña. Recibirás un enlace de acceso en tu correo electrónico.</p></section><div class="card"><form id="login-form"><div class="field"><label for="email">Correo electrónico del docente</label><input id="email" type="email" autocomplete="email" placeholder="docente@liceo.cl" maxlength="254" required /></div><button class="btn block" type="submit">Enviar enlace de acceso</button></form><p class="hint">Abre el enlace desde el mismo navegador o desde el dispositivo en que quieras utilizar el panel. Este acceso requiere una cuenta docente autorizada en Supabase.</p></div></div>`;}
async function teacherList(){setView('teacher-list');app.innerHTML='<div class="loading">Cargando evaluaciones…</div>';
 try{state.exams=await teacherExams();app.innerHTML=`<div class="subhead"><div><div class="eyebrow">Área docente</div><h1>Mis evaluaciones</h1><p class="muted mini">Cree una prueba y comparta su código cuando esté publicada.</p></div><button class="btn" data-action="new-exam">+ Nueva prueba</button></div><div class="exam-list">${state.exams.length?state.exams.map(e=>`<article class="exam-row"><div><h3>${esc(e.title)} <span class="pill ${esc(e.status)}">${statusLabel(e.status)}</span></h3><div class="exam-meta"><span>Código <b>${esc(e.code)}</b></span><span>Tiempo máximo: ${e.duration_minutes} min</span><span>${fmt(e.created_at)}</span></div></div><div class="btn-row"><button class="btn btn-outline small" data-action="open-exam" data-id="${e.id}">${e.status==='draft'?'Editar':'Supervisar'}</button><button class="btn btn-outline small" data-action="duplicate-exam" data-id="${esc(e.id)}">Duplicar prueba</button><button class="btn btn-outline small" data-action="export-exam-script" data-id="${esc(e.id)}">Generar script</button><button class="btn btn-danger small" data-action="delete-exam" data-id="${esc(e.id)}" ${e.status==='published'?'disabled title="Cierra primero esta evaluación"':''}>Eliminar</button></div></article>`).join(''):'<div class="card empty">Todavía no has creado una evaluación.</div>'}</div>`;}catch(e){err(e);viewHome()}}
let teacherMutationBusy=false;
async function duplicateExam(id){
 if(teacherMutationBusy)return;
 if(!state.teacher&&!isDemo)throw Error('Acceso no autorizado.');
 const ex=state.exams.find(e=>e.id===id)||(state.exam?.id===id?state.exam:null);
 if(!ex)throw Error('No se encontró la evaluación.');
 const title=prompt('Nombre de la copia. Puedes añadir el curso de destino.',ex.title.slice(0,185)+' — Copia');
 if(title===null)return;
 const name=title.trim();
 if(name.length<3||name.length>200)throw Error('El nombre debe tener entre 3 y 200 caracteres.');
 teacherMutationBusy=true;
 try{
  let newId;
  if(isDemo){
   const d=db(),dst={...ex,id:uid(),title:name,code:code(),status:'draft',created_at:iso()};
   d.exams.push(dst);d.questions.push(...copy(d.questions.filter(q=>q.exam_id===id)).map(q=>({...q,id:uid(),exam_id:dst.id})));putDb(d);newId=dst.id;
  }else{
   const r=await supa.rpc('qx_duplicate_exam',{p_exam:id,p_title:name,p_code:code()});
   if(r.error&&missingPedagogy(r.error))throw Error('Ejecuta actualizacion_v56.sql en Supabase para activar la duplicación.');
   newId=check(r);
  }
  state.exams=await teacherExams();await openExam(newId);
  toast('Copia creada como borrador, con código nuevo y sin alumnos ni resultados.',6000);
 }finally{teacherMutationBusy=false}
}
async function removeParticipant(id){
 if(teacherMutationBusy||state.view!=='dashboard')return;
 if(!state.teacher&&!isDemo)throw Error('Acceso no autorizado.');
 const ex=state.exam,st=state.snapshot?.students.find(x=>x.id===id);
 if(!st)throw Error('El alumno ya no figura en esta prueba.');
 const answered=(state.snapshot.answers||[]).filter(a=>a.participant_id===id).length;
 if(!confirm('¿Eliminar el registro de '+st.name+' ('+(st.curso||'sin curso')+', lista '+(st.numero_lista??'—')+') de esta evaluación? Se eliminarán '+answered+' respuesta(s), las calificaciones e incidencias de este intento. Su sesión dejará de ser válida y podrá volver a inscribirse si la prueba sigue abierta. Esta acción es irreversible.'))return;
 teacherMutationBusy=true;
 try{
  if(isDemo){const d=db();d.students=d.students.filter(x=>x.id!==id||x.exam_id!==ex.id);d.answers=d.answers.filter(a=>a.participant_id!==id);d.events=d.events.filter(e=>e.participant_id!==id);putDb(d)}
  else{const r=await supa.rpc('qx_remove_participant',{p_exam:ex.id,p_participant:id});if(r.error&&missingPedagogy(r.error))throw Error('Ejecuta actualizacion_v56.sql en Supabase para eliminar registros.');if(!check(r))throw Error('El intento ya no existe o no se pudo eliminar.')}
  if(state.view==='dashboard'&&state.exam?.id===ex.id){if(state.selectedStudent===id)state.selectedStudent=null;await refreshDashboard();}
  toast('Registro eliminado. Cupo liberado.',6000);
 }finally{teacherMutationBusy=false}
}
async function deleteExam(id){
 if(!state.teacher&&!isDemo)throw Error('Acceso no autorizado.');
 const ex=state.exams.find(e=>e.id===id);
 if(!ex)throw Error('No se encontró la evaluación.');
 if(ex.status==='published')throw Error('Cierra la evaluación antes de eliminarla.');
 const entered=prompt('Eliminar permanentemente «'+ex.title+'» y sus datos asociados. Exporta antes los informes que quieras conservar. Escribe el código '+ex.code+' para confirmar.');
 if(entered===null)return;
 if(entered.trim()!==ex.code)throw Error('Código incorrecto. No se eliminó la evaluación.');
 if(isDemo){const d=db(),ids=new Set(d.students.filter(x=>x.exam_id===id).map(x=>x.id));d.events=d.events.filter(x=>!ids.has(x.participant_id));d.answers=d.answers.filter(x=>!ids.has(x.participant_id));d.students=d.students.filter(x=>x.exam_id!==id);d.questions=d.questions.filter(x=>x.exam_id!==id);d.exams=d.exams.filter(x=>x.id!==id);putDb(d)}
 else{const r=await supa.from('qx_exams').delete().eq('id',id).eq('teacher_id',state.teacher.id).in('status',['draft','closed']).select('id');const removed=check(r);if(!removed?.length)throw Error('No se pudo eliminar: revisa el estado y los permisos de Supabase.')}
 if(state.exam?.id===id){state.exam=null;state.questions=[];state.draft=[];state.snapshot=null}
 await teacherList();toast('Evaluación eliminada.');
}
function statusLabel(s){return ({draft:'Borrador',published:'Publicada',closed:'Cerrada'})[s]||s}
function draftQuestion(){return {kind:'single',prompt:'',options:['','','',''],correct:[],points:1};}
async function newExam(){const e={title:'Nueva evaluación',description:'',code:code(),duration_minutes:60,status:'draft'};try{state.exam=await teacherCreate(e);pedagogy=await loadPedagogy(state.exam);state.questions=[];state.draft=[draftQuestion()];editor()}catch(ex){err(ex)}}
async function openExam(id){const exam=state.exams.find(x=>x.id===id)||state.exam;if(!exam)return;state.exam=exam;try{state.questions=await teacherQuestions(exam);state.draft=copy(state.questions);if(exam.status==='draft'){if(!state.draft.length)state.draft=[draftQuestion()];editor()}else dashboard()}catch(e){err(e)}}
function editor(){if(pendingPdf&&pendingPdf.examId!==state.exam?.id)pendingPdf=null;setView('editor');const ex=state.exam;app.innerHTML=`<div class="subhead"><div><div class="eyebrow">Editor de pruebas · Borrador</div><h1>Configurar evaluación</h1></div><button class="btn btn-ghost" data-action="teacher-list">← Mis evaluaciones</button></div><div class="ped-import-grid">${examImportHTML()}${specEditorHTML()}</div><div class="form-columns"><section><div class="card" style="margin-bottom:19px"><div class="field"><label for="exam-title">Título de la evaluación</label><input id="exam-title" maxlength="200" value="${esc(ex.title)}" /></div><div class="field"><label for="exam-description">Instrucciones para los estudiantes</label><textarea id="exam-description">${esc(ex.description)}</textarea></div><div class="field"><label for="exam-duration">Tiempo máximo para rendir la prueba (minutos)</label><input type="number" min="1" max="300" id="exam-duration" value="${ex.duration_minutes}" /><p class="hint">De 1 a 300 minutos. Comienza con el primer ingreso de cada estudiante y no se reinicia al actualizar la página. Al finalizar, se bloquean las respuestas y se registra la entrega.</p><div class="btn-row exam-duration-presets"><button type="button" class="btn btn-outline small" data-action="duration-preset" data-minutes="30">30 min</button><button type="button" class="btn btn-outline small" data-action="duration-preset" data-minutes="45">45 min</button><button type="button" class="btn btn-outline small" data-action="duration-preset" data-minutes="60">60 min</button><button type="button" class="btn btn-outline small" data-action="duration-preset" data-minutes="90">90 min</button><button type="button" class="btn btn-outline small" data-action="duration-preset" data-minutes="120">120 min</button></div></div><div class="field"><label for="exam-exigencia">Porcentaje de exigencia (%)</label><input id="exam-exigencia" type="number" min="1" max="99" step="1" value="${exigenciaOf(ex)}"><p class="hint">Nota 4,0 al alcanzar este porcentaje. Escala de 1,0 a 7,0.</p></div><div class="field"><label class="ocr-option"><input type="checkbox" id="exam-immediate" ${ex.resultado_inmediato!==false?"checked":""}> Entregar puntaje, nota y retroalimentación cualitativa al finalizar (solo alternativas)</label><p class="hint">No se muestran aciertos, errores, categorías específicas ni la pauta.</p></div><div class="field"><label>Código de acceso</label><span class="code">${esc(ex.code)}</span></div></div><div class="subhead"><h2 class="section-title" style="margin:0">Preguntas <span class="pill">${state.draft.length}</span></h2><button class="btn btn-outline small" data-action="add-question">+ Añadir pregunta</button></div><div class="stack" id="question-editors">${state.draft.map(questionEditorHTML).join('')}</div><div class="btn-row" style="margin-top:22px"><button class="btn btn-outline" data-action="save-draft">Guardar borrador</button><button class="btn btn-green" data-action="publish">Guardar y publicar</button></div></section><aside>${scriptExportCard()}<div class="notice warning" style="margin-top:15px">El importador extrae solo preguntas y alternativas. Revisa el orden, la pauta y los enunciados; añade manualmente los textos de lectura o imágenes imprescindibles. El OCR puede cometer errores.</div></aside></div>`;insertExamQR(ex);if(pendingPdf?.examId===ex.id)showPDFReview(pendingPdf);}
function questionEditorHTML(q,i){const options=Array.isArray(q.options)?q.options:[];const correct=Array.isArray(q.correct)?q.correct.map(x=>Number(x)+1).join(', '):'';return `<article class="question-editor" data-q="${i}"><div class="editor-top"><h3>Pregunta ${i+1}</h3><button class="btn btn-ghost small" data-action="remove-question" data-i="${i}">Eliminar</button></div><div class="field"><label>Enunciado</label><textarea data-field="prompt" placeholder="Escriba el enunciado">${esc(q.prompt)}</textarea></div><div class="editor-grid"><div class="field"><label>Tipo de pregunta</label><select data-field="kind"><option value="single" ${q.kind==='single'?'selected':''}>Selección única</option><option value="multi" ${q.kind==='multi'?'selected':''}>Selección múltiple</option><option value="short" ${q.kind==='short'?'selected':''}>Respuesta abierta</option></select></div><div class="field"><label>Puntaje</label><input type="number" min="0" max="100" step="0.5" data-field="points" value="${esc(q.points)}" /></div></div><div class="field choice-config ${q.kind==='short'?'hidden':''}"><label>Alternativas (una por línea)</label><textarea data-field="options" rows="5" placeholder="Alternativa A&#10;Alternativa B&#10;Alternativa C">${esc(options.join('\n'))}</textarea><span class="hint">Sin letras A, B, C ni numeración. Se agregarán automáticamente.</span></div><div class="field choice-config ${q.kind==='short'?'hidden':''}"><label>Alternativa(s) correcta(s)</label><input data-field="correct" value="${esc(correct)}" placeholder="Ej.: 2, o 1, 3 para selección múltiple" /><span class="hint">Ingrese el número de la alternativa, comenzando por 1. Es obligatorio antes de publicar.</span></div>${categoryFields(q)}</article>`;}
function collectDraft(){const container=$('#question-editors');if(!container)return;pedagogy.dimensions=dimensionsOf([0,1,2].map(i=>$('#ped-dim-'+i)?.value||pedagogy.dimensions[i]));state.exam={...state.exam,title:$('#exam-title')?.value??state.exam.title,description:$('#exam-description')?.value??state.exam.description,duration_minutes:Number($('#exam-duration')?.value??state.exam.duration_minutes),exigencia:Number($('#exam-exigencia')?.value??state.exam.exigencia??60),resultado_inmediato:$('#exam-immediate')?.checked??state.exam.resultado_inmediato??true};state.draft=[...container.querySelectorAll('[data-q]')].map(node=>{const get=k=>node.querySelector(`[data-field="${k}"]`)?.value??'';let options=get('options').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);let kind=get('kind');let correct=[...new Set(get('correct').split(/[,;\s]+/).map(x=>Number(x)).filter(n=>Number.isInteger(n)&&n>0).map(n=>n-1))].sort((a,b)=>a-b);return {kind,prompt:get('prompt').trim(),points:Number(get('points')),options:kind==='short'?[]:options,correct:kind==='short'?[]:correct,categories:tagsOf([0,1,2].map(i=>get('category-'+i)))}});state.importText=$('#script-input')?.value||state.importText;}
function validateDraft(publicar=false){const title=$('#exam-title')?.value.trim()||state.exam.title,minutes=Number($('#exam-duration')?.value);if(!Number.isInteger(state.exam.exigencia)||state.exam.exigencia<1||state.exam.exigencia>99)throw Error('La exigencia debe estar entre 1 y 99 %.');if(title.length<3)throw Error('Escriba un título de al menos 3 caracteres');if(!Number.isInteger(minutes)||minutes<1||minutes>300)throw Error('La duración debe estar entre 1 y 300 minutos');if(publicar&&!state.draft.length)throw Error('Añada al menos una pregunta');for(let i=0;i<state.draft.length;i++){const q=state.draft[i];if(!q.prompt)throw Error(`Falta el enunciado de la pregunta ${i+1}`);if(!Number.isFinite(q.points)||q.points<0||q.points>100)throw Error(`Puntaje inválido en pregunta ${i+1}`);if(q.kind!=='short'){if(q.options.length<2||q.options.length>10)throw Error(`La pregunta ${i+1} necesita entre 2 y 10 alternativas`);if(q.correct.some(n=>n>=q.options.length))throw Error(`Revise la pauta de la pregunta ${i+1}`);if(publicar&&q.correct.length===0)throw Error(`Indique la alternativa correcta en la pregunta ${i+1}`);if(q.kind==='single'&&q.correct.length>1)throw Error(`La pregunta ${i+1} solo admite una respuesta correcta`)}}}
async function saveDraft(publicar=false){if(importBusy||pendingPdf?.examId===state.exam.id)throw Error('Termina o cancela la importación del PDF antes de guardar.');collectDraft();validateDraft(publicar);const ex=state.exam;if(!isDemo&&(state.draft.some(q=>tagsOf(q.categories).some(Boolean))||JSON.stringify(pedagogy.dimensions)!==JSON.stringify(DEFAULT_DIMENSIONS))){const p=await loadPedagogy(ex);if(!p.ready)throw Error('Activa primero actualizacion_v5.sql en Supabase para guardar las categorías.')}const patch={title:$('#exam-title').value.trim(),description:$('#exam-description').value,duration_minutes:Number($('#exam-duration').value),exigencia:state.exam.exigencia,resultado_inmediato:state.exam.resultado_inmediato};try{state.exam=await teacherUpdate(ex,patch)}catch(e){if(['42703','PGRST204'].includes(e?.code))throw Error('Ejecuta actualizacion_v57.sql en Supabase antes de guardar esta configuración.');throw e}await teacherReplaceQuestions(state.exam,state.draft);state.questions=await teacherQuestions(state.exam);if(publicar){state.exam=await teacherUpdate(state.exam,{status:'published'});toast('Prueba publicada y disponible para los estudiantes');return dashboard()}toast('Borrador guardado correctamente');state.draft=copy(state.questions);editor();}

/* ============================= IMPORTACIÓN ============================= */
function parseTextQuestions(text){const lines=text.replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean);const qs=[];let current=null,lastOption=-1;
const qre=/^(?:(?:pregunta|ítem|item)\s*)?(\d{1,3})\s*[.)\-:]\s*(.+)$/i;
const ore=/^([a-jA-J])\s*[.)\-:]\s*(.+)$/;
for(const ln of lines){const qmatch=ln.match(qre),omatch=ln.match(ore);if(qmatch){if(current)qs.push(current);current={kind:'single',prompt:qmatch[2],sourceNumber:Number(qmatch[1]),options:[],correct:[],points:1};lastOption=-1;continue}if(omatch&&current){current.options.push(omatch[2]);lastOption=current.options.length-1;continue}if(current){if(lastOption>=0)current.options[lastOption]+=' '+ln;else current.prompt+=' '+ln}}
if(current)qs.push(current);return qs.filter(q=>q.prompt&&q.options.length>=2).map(q=>({...q,options:q.options.slice(0,10)}));}
function decodeJS(s){return s.replace(/\\([\\'"`nrt])/g,(_,c)=>({n:'\n',r:'\r',t:'\t'}[c]||c));}
function quotedStrings(src){const found=[];const re=/(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;let m;while((m=re.exec(src)))found.push(decodeJS(m[2]));return found;}
function parseJSDataLiteral(source, offset) {
  let pos = offset, depth = 0, count = 0;
  function spaces() {
    while (pos < source.length) {
      if (/\s/.test(source[pos])) { pos++; continue; }
      if (source.startsWith('//', pos)) { pos = source.indexOf('\n', pos + 2); if (pos < 0) pos = source.length; continue; }
      if (source.startsWith('/*', pos)) { const end = source.indexOf('*/', pos + 2); if (end < 0) throw Error('Comentario sin cerrar'); pos = end + 2; continue; }
      break;
    }
  }
  function stringValue() {
    const quote = source[pos++]; let value = '';
    while (pos < source.length) {
      let c = source[pos++];
      if (c === quote) return value;
      if (quote === String.fromCharCode(96) && c === '$' && source[pos] === '{') throw Error('No se admiten expresiones dinámicas en las preguntas');
      if (c !== '\\') { value += c; continue; }
      if (pos >= source.length) throw Error('Secuencia de escape incompleta');
      c = source[pos++];
      if (c === '\n') continue;
      if (c === '\r') { if (source[pos] === '\n') pos++; continue; }
      const simple = { n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', v:'\v', '0':'\0' };
      if (Object.prototype.hasOwnProperty.call(simple,c)) { value += simple[c]; continue; }
      if (c === 'u' || c === 'x') {
        const len = c === 'u' ? 4 : 2;
        if (source[pos] === '{' && c === 'u') {
          const end = source.indexOf('}', pos + 1);
          if (end < 0) throw Error('Código Unicode incompleto');
          const hex = source.slice(pos + 1,end);
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) throw Error('Código Unicode inválido');
          value += String.fromCodePoint(parseInt(hex,16)); pos = end + 1; continue;
        }
        const hex = source.slice(pos, pos + len);
        if (!new RegExp('^[0-9a-fA-F]{'+len+'}$').test(hex)) throw Error('Escape inválido');
        value += String.fromCharCode(parseInt(hex,16)); pos += len; continue;
      }
      value += c;
    }
    throw Error('Texto sin cerrar');
  }
  function ident() {
    const m = /^[a-zA-Z_$][a-zA-Z0-9_$]*/.exec(source.slice(pos));
    if (!m) throw Error('Se esperaba un nombre de propiedad');
    pos += m[0].length; return m[0];
  }
  function value() {
    spaces();
    if (++count > 25000 || ++depth > 25) throw Error('La estructura es demasiado grande');
    let output;
    if (source[pos] === '{') {
      output = {}; pos++; spaces();
      while (source[pos] !== '}') {
        spaces();
        if (pos >= source.length) throw Error('Objeto sin cerrar');
        const key = /['"]/.test(source[pos]) || source.charCodeAt(pos)===96 ? stringValue() : ident();
        spaces(); if (source[pos++] !== ':') throw Error('Falta dos puntos');
        const field = value();
        if (['__proto__','prototype','constructor'].includes(key)) throw Error('Propiedad no admitida');
        output[key] = field;
        spaces();
        if (source[pos] === '}') break;
        if (source[pos++] !== ',') throw Error('Falta una coma');
        spaces();
      }
      pos++;
    } else if (source[pos] === '[') {
      output = []; pos++; spaces();
      while (source[pos] !== ']') {
        if (pos >= source.length) throw Error('Arreglo sin cerrar');
        output.push(value()); spaces();
        if (source[pos] === ']') break;
        if (source[pos++] !== ',') throw Error('Falta una coma');
        spaces();
      }
      pos++;
    } else if (/['"]/.test(source[pos]) || source.charCodeAt(pos)===96) {
      output = stringValue();
    } else if (/[-+\d.]/.test(source[pos])) {
      const m = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(source.slice(pos));
      if (!m) throw Error('Número inválido');
      output = Number(m[0]); pos += m[0].length;
    } else {
      const id = ident();
      if (id === 'true') output = true;
      else if (id === 'false') output = false;
      else if (id === 'null' || id === 'undefined') output = null;
      else throw Error('Este campo contiene una expresión y no un dato literal');
    }
    depth--; return output;
  }
  return value();
}
function parseQuestionsFromData(source) {
  const assignments = /\b(?:const|let|var)\s+(secciones|preguntas|bloques|items|cuestionario|evaluacion)\s*=\s*(?=\[)/gi;
  const result = [];
  for (const match of source.matchAll(assignments)) {
    let data;
    try { data = parseJSDataLiteral(source, match.index + match[0].length); }
    catch (e) { continue; }
    if (!Array.isArray(data)) continue;
    let lastHeading = '';
    function visit(items, heading = '') {
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const nextHeading = typeof item.titulo === 'string' ? item.titulo.trim() : heading;
        if (Array.isArray(item.preguntas)) { visit(item.preguntas, nextHeading); continue; }
        if (Array.isArray(item.secciones)) { visit(item.secciones, nextHeading); continue; }
        const prompt = item.enunciado ?? item.pregunta ?? item.prompt ?? item.texto;
        const choices = item.opciones ?? item.alternativas ?? item.options;
        const explicitKind=item.tipo??item.kind;
        if(explicitKind==='short'&&typeof prompt==='string'&&prompt.trim()){const points=Number(item.puntos??item.puntaje??item.points??1);result.push({kind:'short',prompt:prompt.trim(),options:[],correct:[],points:Number.isFinite(points)?points:1,sourceNumber:Number(item.numero)||undefined,categories:categoriesFrom(item,heading)});continue}
        if (typeof prompt !== 'string' || !Array.isArray(choices) || choices.length < 2 || choices.length > 10 || !choices.every(x => typeof x === 'string')) continue;
        let options = choices.map(s => s.trim());
        const hasLetters = !explicitKind && options.every((s,i) => new RegExp('^' + String.fromCharCode(65+i) + '[\\)\\.\\:\\-]\\s+', 'i').test(s));
        if (hasLetters) options = options.map((s,i) => s.replace(new RegExp('^' + String.fromCharCode(65+i) + '[\\)\\.\\:\\-]\\s+', 'i'), ''));
        let correct = item.correcta ?? item.respuestaCorrecta ?? item.correct ?? item.correctas;
        const normalize = x => typeof x === 'number' ? x : typeof x === 'string' && /^[A-J]$/i.test(x.trim()) ? x.toUpperCase().charCodeAt(0)-65 : null;
        correct = (Array.isArray(correct) ? correct : [correct]).map(normalize).filter(x => Number.isInteger(x) && x >= 0 && x < options.length);
        const points = Number(item.puntos ?? item.puntaje ?? item.points ?? 1);
        const showHeading = heading && heading !== lastHeading;
        result.push({kind:explicitKind==='multi'||correct.length>1?'multi':'single', prompt:(showHeading ? heading+'\n\n' : '')+prompt.trim(), options, correct, points:Number.isFinite(points)?points:1,sourceNumber:Number(item.numero??prompt.trim().match(/^(\d{1,3})\s*[.)\-:]/)?.[1])||undefined,categories:categoriesFrom(item,heading)});
        if (heading) lastHeading = heading;
      }
    }
    visit(data);
    if (result.length) return result;
  }
  return result;
}

function parseAppsScript(src){const dataQuestions=parseQuestionsFromData(src);if(dataQuestions.length)return mergeScriptSpecs(dataQuestions,src);const headers=[...src.matchAll(/add(MultipleChoice|Checkbox|Text|ParagraphText)Item\s*\(\s*\)/g)];const qs=[];
for(let i=0;i<headers.length;i++){const h=headers[i], chunk=src.slice(h.index+(h[0]||'').length,headers[i+1]?.index??src.length);const kind=h[1]==='MultipleChoice'?'single':h[1]==='Checkbox'?'multi':'short';const titleChunk=chunk.match(/\.setTitle\s*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1\s*\)/);if(!titleChunk)continue;let opts=[];let correct=[];const choices=chunk.match(/\.setChoiceValues\s*\(\s*\[([\s\S]*?)\]\s*\)/);
if(choices)opts=quotedStrings(choices[1]);else{const choiceR=/\.createChoice\s*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1\s*(?:,\s*(true|false))?\s*\)/g;for(const match of chunk.matchAll(choiceR)){opts.push(decodeJS(match[2]));if(match[3]==='true')correct.push(opts.length-1)}}
const pt=chunk.match(/\.setPoints\s*\(\s*(\d+(?:\.\d+)?)\s*\)/);qs.push({kind,prompt:decodeJS(titleChunk[2]),options:kind==='short'?[]:opts,correct,points:pt?Number(pt[1]):1})}
return mergeScriptSpecs(qs.filter(q=>q.kind==='short'||q.options.length>=2),src);}
function addImported(items,source){if(!items.length)throw Error('No se detectaron preguntas compatibles. Revise el formato y agréguelas manualmente');collectDraft();if(state.draft.length===1&&!state.draft[0].prompt)state.draft=[];state.draft.push(...items.slice(0,100-state.draft.length));editor();toast(`${items.length} pregunta(s) importadas desde ${source}. Revise cada alternativa y su pauta.`,6000);}



/* v5.1 — dos entradas de archivos independientes. */
let importBusy=false;
let pendingPdf=null;
const importStatus={exam:null,spec:null};
function dropZoneHTML(kind){
 const exam=kind==='exam',id='drop-file-'+kind,accept=exam?'.pdf,.gs,.js,.txt,application/pdf,text/plain':'.pdf,.csv,.tsv,.txt,application/pdf,text/csv,text/plain';
 const status=importStatus[kind]?.examId===state.exam?.id?importStatus[kind]:null;
 return '<div class="file-drop-area" data-drop-kind="'+kind+'"><div class="file-drop-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V3M7 8l5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></svg></div><strong>Arrastra y suelta '+(exam?'la prueba':'la tabla de especificaciones')+'</strong><span class="hint">'+(exam?'PDF digital o escaneado · Apps Script (.gs, .js, .txt)':'PDF digital o escaneado, CSV, TSV o TXT')+'</span><label for="'+id+'" class="btn btn-outline small">Seleccionar archivo</label><input id="'+id+'" data-import-kind="'+kind+'" type="file" accept="'+accept+'" class="hidden-file"><p class="file-drop-status'+(status?.error?' file-drop-error':'')+'" role="status" aria-live="polite">'+esc(status?.message||'Ningún archivo cargado')+'</p></div>';
}
function scriptExportCard(){
 return '<section class="import-card" style="margin-top:15px"><div class="eyebrow">Exportación · Google Forms</div><h3>Generar Google Apps Script</h3><p class="hint">Después de incorporar el PDF y revisar las respuestas correctas y categorías, genera el script de la evaluación y su tabla de especificaciones.</p><button class="btn btn-green small" data-action="generate-script">Generar script</button><div id="script-export-result"></div></section>';
}
function showScriptExport(code,title){
 const root=$('#script-export-result')||app.querySelector('.exam-script-modal');
 if(!root){
  const dialog=document.createElement('dialog');dialog.className='exam-script-modal';app.appendChild(dialog);
  dialog.innerHTML='<h2>Google Apps Script</h2><div id="script-export-result"></div><button class="btn btn-outline small" data-action="close-script-export">Cerrar</button>';
  dialog.showModal();return showScriptExport(code,title);
 }
 root.innerHTML='<p class="hint">Script generado. Copia o descarga el archivo .gs y ejecuta crearEvaluacion en Google Apps Script. Requiere autorización de Google. No incluye las funciones de supervisión ni temporizador.</p><textarea id="generated-script" class="input script-preview" readonly rows="10">'+esc(code)+'</textarea><div class="btn-row"><button class="btn btn-outline small" data-action="copy-generated-script">Copiar</button><button class="btn btn-green small" data-action="download-generated-script">Descargar .gs</button><a class="btn btn-outline small" href="https://script.google.com/" target="_blank" rel="noopener noreferrer">Abrir Apps Script</a></div>';
 root.dataset.title=title;
}
async function exportSavedExamScript(id){
 const ex=state.exams.find(e=>e.id===id);if(!ex)throw Error('Evaluación no encontrada.');
 const previous=pedagogy;
 try{const qs=await teacherQuestions(ex);const output=generateGoogleScript(ex,qs,pedagogy.dimensions);showScriptExport(output,ex.title)}
 finally{pedagogy=previous}
}
function examImportHTML(){
 return '<section class="import-card"><div class="eyebrow">01 · Evaluación</div><h3>Importar prueba</h3><p class="hint">Carga el PDF o script. Se extraen los ítems en su orden original, sin transcribir toda la prueba. Si el PDF es escaneado, se utiliza OCR en español.</p>'+dropZoneHTML('exam')+'<label class="ocr-option"><input type="checkbox" id="force-pdf-ocr"> Forzar OCR en todas las páginas del PDF</label><div id="pdf-review"></div><details class="ped-import-paste"><summary>O pegar Google Apps Script</summary><textarea id="script-input" class="input" rows="5" placeholder="Pega el código de tu evaluación">'+esc(state.importText)+'</textarea><button type="button" class="btn btn-outline small" data-action="import-script">Analizar script</button></details></section>';
}
function setImportStatus(kind,message,error=false){
 importStatus[kind]={examId:state.exam?.id,message,error};
 const el=app.querySelector('[data-drop-kind="'+kind+'"] .file-drop-status');
 if(el){el.textContent=message;el.classList.toggle('file-drop-error',error)}
}
async function importDroppedFile(kind,file){
 if(state.view!=='editor'||!file)return;
 if(pendingPdf?.examId===state.exam.id){toast('Incorpora o cancela el PDF pendiente antes de cargar otro archivo.');return}
 if(importBusy){toast('Espera a que termine la importación actual.');return}
 const examId=state.exam?.id,ext=file.name.split('.').pop().toLowerCase();
 const isCurrent=()=>state.view==='editor'&&state.exam?.id===examId;
 if(kind==='exam'&&!['pdf','gs','js','txt'].includes(ext)||kind==='spec'&&!['pdf','csv','tsv','txt'].includes(ext)){setImportStatus(kind,'Formato no compatible: '+file.name,true);return}
 if(file.size>15*1024*1024){setImportStatus(kind,'El archivo supera el máximo de 15 MB.',true);return}
 if(kind==='spec'&&![...app.querySelectorAll('[data-field="prompt"]')].some(q=>q.value.trim())){setImportStatus(kind,'Primero importa la prueba para poder vincular sus preguntas.',true);return}
 importBusy=true;setImportStatus(kind,'Procesando '+file.name+'…');
 try{
  if(kind==='exam'){
   let qs,importedNames=null;
   if(ext==='pdf'){
    const result=await readPDF(file,{forceOCR:!!$('#force-pdf-ocr')?.checked,onProgress:msg=>{if(isCurrent())setImportStatus(kind,msg)}});
    if(!isCurrent())return;
    const parsed=parsePDFExam(result.text);
    pendingPdf={examId,name:file.name,...result,parsed,excluded:new Set()};
    showPDFReview(pendingPdf);
    setImportStatus(kind,file.name+' · '+parsed.questions.length+' preguntas detectadas en '+result.pageCount+' página(s). Revisa solo los ítems reconocidos.');
    return;
   }else{
    const text=await file.text();
    qs=parseAppsScript(text);importedNames=importDimensionNames(text);
    if(!qs.length&&ext==='txt')qs=parseTextQuestions(text);
   }
   if(!isCurrent())return;
   if(!qs.length)throw Error('No se detectaron preguntas compatibles. Comprueba el formato.');
   collectDraft();
   const existing=state.draft.filter(q=>q.prompt.trim()).length;
   if(existing&&!confirm('La evaluación ya contiene '+existing+' preguntas. ¿Añadir las nuevas al final?')){setImportStatus(kind,'Importación cancelada; se conservaron las preguntas.');return}
   const room=100-(state.draft.length===1&&!state.draft[0].prompt?0:state.draft.length);
   if(room<=0)throw Error('Se alcanzó el máximo de 100 preguntas.');
   const count=Math.min(room,qs.length);
   if(importedNames){pedagogy.dimensions=importedNames;importedNames.forEach((n,i)=>{const el=$('#ped-dim-'+i);if(el)el.value=n})}
   pendingSpecRows=[];
   setImportStatus(kind,file.name+' · '+count+' pregunta(s) incorporadas.'+(count<qs.length?' Límite de 100 preguntas alcanzado.':''));
   addImported(qs.slice(0,count),file.name);
  }else{
   const result=ext==='pdf'?await readPDF(file,{onProgress:msg=>{if(isCurrent())setImportStatus(kind,msg)}}):null;
   const text=result?result.table:await file.text();
   if(!isCurrent())return;
   collectDraft();
   const parsed=parseSpecificationTable(ext==='csv'?csvToTabular(text):text,pedagogy.dimensions);
   if(result?.ocrPages.length){
    const area=$('#spec-table');if(area){area.value=text;area.closest('details').open=true}
    parsed.warnings.push('Se utilizó OCR. Si las columnas no se reconocen, corrige el texto de la tabla con separadores | antes de interpretar.');
    if(!parsed.rows.length){setImportStatus(kind,'OCR completado. Corrige los separadores de columnas en el cuadro de texto de especificaciones.',true);return}
   }
   previewSpecImport(parsed);
   setImportStatus(kind,file.name+' · '+parsed.rows.length+' fila(s) detectadas. Revisa y aplica las categorías.');
  }
 }catch(e){if(isCurrent()){setImportStatus(kind,e.message||String(e),true);err(e)}}
 finally{importBusy=false}
}


function showPDFReview(result){
 const root=$('#pdf-review');if(!root)return;
 const parsed=result.parsed||parsePDFExam(result.text),qs=parsed.questions;
 const excluded=result.excluded||new Set(),closed=qs.filter(q=>q.kind!=='short'),keyed=closed.filter(q=>q.correct.length);
 root.innerHTML='<div class="pdf-review-box"><h3>Preguntas detectadas</h3><p class="hint">'+result.pageCount+' página(s) · '+result.ocrPages.length+' con OCR · '+qs.length+' preguntas · '+keyed.length+' / '+closed.length+' cerradas con pauta explícita.</p><p class="hint">Solo se importan los ítems seleccionados, con sus alternativas, en el orden en que aparecen. No se incorporan automáticamente encabezados, instrucciones ni textos de lectura. Revisa si alguna pregunta necesita contexto adicional.</p>'+
 (qs.length?'<div class="pdf-item-list">'+qs.map((q,i)=>'<article class="pdf-detected-item"><label class="pdf-item-select"><input type="checkbox" data-pdf-index="'+i+'" '+(!excluded.has(i)?'checked':'')+'><span>Pregunta original '+esc(q.sourceNumber)+' · '+(q.kind==='short'?'Posible desarrollo':q.kind==='multi'?'Selección múltiple':'Selección')+'</span></label><div class="pdf-item-prompt">'+esc(q.prompt)+'</div>'+(q.options.length?'<ol type="A">'+q.options.map((op,j)=>'<li>'+esc(op)+((q.correct||[]).includes(j)?' <b class="pdf-key">(Pauta)</b>':'')+'</li>').join('')+'</ol>':'')+'<p class="hint">'+num(q.points)+' punto(s)'+(q.kind!=='short'&&!q.correct.length?' · Sin pauta reconocida':'')+'</p></article>').join('')+'</div>':'<p class="notice warning">No se reconocieron preguntas numeradas compatibles. Prueba con OCR forzado o incorpóralas manualmente.</p>')+
 (parsed.warnings.length?'<details class="pdf-review-warnings"><summary>'+parsed.warnings.length+' advertencia(s) de reconocimiento</summary><ul>'+parsed.warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul></details>':'')+
 '<p class="hint" id="pdf-selected-count">'+(qs.length-excluded.size)+' de '+qs.length+' preguntas seleccionadas.</p><div class="btn-row"><button class="btn btn-green small" data-action="pdf-apply" '+(!qs.length?'disabled':'')+'>Incorporar preguntas seleccionadas</button><button class="btn btn-outline small" data-action="pdf-cancel">Cancelar</button></div></div>';
}
function applyPDFReview(){
 if(!pendingPdf||pendingPdf.examId!==state.exam.id)throw Error('Carga nuevamente el PDF.');
 const parsed=pendingPdf.parsed||parsePDFExam(pendingPdf.text);
 const qs=parsed.questions.filter((q,i)=>!pendingPdf.excluded?.has(i)).map(q=>({...q,options:[...q.options],correct:[...q.correct]}));
 if(!qs.length)throw Error('Selecciona al menos una pregunta.');
 collectDraft();
 const existing=state.draft.filter(q=>q.prompt.trim()).length;
 if(existing&&!confirm('La evaluación ya contiene '+existing+' preguntas. ¿Añadir las seleccionadas al final, conservando su orden?'))return;
 const room=100-(state.draft.length===1&&!state.draft[0].prompt?0:state.draft.length);
 if(qs.length>room)throw Error('La selección supera el máximo de 100 preguntas. Desmarca algunas antes de incorporarlas.');
 const marker=pendingPdf.table.search(/^\s*tabla de especificaciones\s*$/im);
 if(marker>=0){const table=parseSpecificationTable(pendingPdf.table.slice(marker),pedagogy.dimensions);if(table.rows.length)applyImportedSpecs(qs,table.rows,true)}
 const missing=qs.filter(q=>q.kind!=='short'&&!q.correct.length).length;
 const source=pendingPdf.name;pendingPdf=null;pendingSpecRows=[];
 setImportStatus('exam',source+' · '+qs.length+' preguntas incorporadas en el orden original.'+(missing?' '+missing+' preguntas cerradas sin pauta.':''));
 addImported(qs,source);
}

function csvToTabular(text){
 const raw=String(text).replace(/^\ufeff/,'');
 // CSV con comillas y comas; los archivos delimitados por punto y coma o tabulador conservan su separador.
 const header=raw.split(/\r?\n/,1)[0];
 const delim=header.includes(';')?';':header.includes('\t')?'\t':',';
 const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<raw.length;i++){const c=raw[i];if(c==='"'){if(quoted&&raw[i+1]==='"'){field+='"';i++}else quoted=!quoted}
 else if(c===delim&&!quoted){row.push(field);field=''}
 else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&raw[i+1]==='\n')i++;row.push(field);rows.push(row);row=[];field=''}
 else field+=c}
 if(quoted)throw Error('CSV con comillas sin cerrar.');
 if(field||row.length){row.push(field);rows.push(row)}
 return rows.map(r=>r.map(v=>v.replace(/[\t\r\n]/g,' ')).join('\t')).join('\n');
}

/* v5 · Editor de especificaciones */
function categoryFields(q){
 const tags=tagsOf(q.categories);
 return '<div class="ped-category-grid">'+dimensionsOf(pedagogy.dimensions).map((d,i)=>'<div class="field"><label>'+esc(d)+'</label><input data-field="category-'+i+'" maxlength="160" value="'+esc(tags[i])+'" placeholder="Opcional"></div>').join('')+'</div>';
}
function specEditorHTML(){
 return '<section class="card ped-spec"><div class="eyebrow">02 · Clasificación pedagógica</div><h3>Tabla de especificaciones</h3><p class="hint">Hasta tres dimensiones opcionales por pregunta. Cambia los nombres aquí y revisa los valores en cada pregunta antes de publicar.</p>'+
 (pedagogy.ready===false?'<p class="notice warning">Para guardar categorías y correcciones abiertas debes ejecutar actualizacion_v5.sql en Supabase.</p>':'')+
 '<div class="ped-category-grid">'+dimensionsOf(pedagogy.dimensions).map((d,i)=>'<div class="field"><label>Dimensión '+(i+1)+'</label><input id="ped-dim-'+i+'" maxlength="80" value="'+esc(d)+'"></div>').join('')+'</div>'+
 '<div class="btn-row"><button type="button" class="btn btn-outline small" data-action="ped-dim-refresh">Actualizar nombres</button><button type="button" class="btn btn-outline small" data-action="ped-spec-preview">Ver tabla</button></div>'+dropZoneHTML('spec')+''+
 '<details style="margin-top:12px"><summary>Pegar tabla de especificaciones</summary><textarea id="spec-table" class="input" rows="5" placeholder="Pregunta | Conocimiento | Habilidad | Eje temático&#10;1 | Personajes | Interpretar | Identidad"></textarea><button type="button" class="btn btn-outline small" data-action="ped-spec-paste">Interpretar tabla</button></details><div id="ped-spec-review"></div></section>';
}
function applyImportedSpecs(items,rows,bySource=false){
 let matched=0,miss=[];
 for(const row of rows){
  const explicit=bySource&&items.some(q=>Number.isInteger(q.sourceNumber));const hits=bySource?items.filter((q,i)=>Number(explicit?q.sourceNumber:i+1)===row.number):items.filter((q,i)=>i+1===row.number);
  if(hits.length!==1){miss.push(row.number);continue;}
  hits[0].categories=tagsOf(row.tags);matched++;
 }
 return {matched,miss};
}
function importDimensionNames(src){
 const match=/\b(?:const|let|var)\s+dimensionesEvaluacion\s*=\s*(?=\[)/i.exec(src);
 if(!match)return null;
 try{const v=parseJSDataLiteral(src,match.index+match[0].length);return Array.isArray(v)&&v.length===3&&v.every(x=>typeof x==='string')?dimensionsOf(v):null}catch(e){return null}
}
function mergeScriptSpecs(items,src){
 const match=/\b(?:const|let|var)\s+(?:tablaEspecificaciones|tabla_especificaciones|especificaciones)\s*=\s*(?=\[)/i.exec(src);
 if(!match)return items;
 try{
  const data=parseJSDataLiteral(src,match.index+match[0].length);
  const rows=data.map(r=>({number:Number(r.numero??r.numeroPregunta??r.pregunta??r.item),tags:categoriesFrom(r)})).filter(r=>Number.isInteger(r.number)&&r.number>=1&&r.tags.some(Boolean));
  applyImportedSpecs(items,rows,true);
 }catch(e){console.warn('No se pudo interpretar tabla de especificaciones en script',e)}
 return items;
}
function showSpecPreview(message=''){
 const panel=$('#ped-spec-review');if(!panel)return;
 panel.innerHTML=(message?'<p class="notice">'+esc(message)+'</p>':'')+'<div class="table-wrap"><table><thead><tr><th>Pregunta</th>'+dimensionsOf(pedagogy.dimensions).map(d=>'<th>'+esc(d)+'</th>').join('')+'</tr></thead><tbody>'+state.draft.map((q,i)=>'<tr><td>'+(i+1)+'</td>'+tagsOf(q.categories).map(c=>'<td>'+esc(c||'—')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
}
function previewSpecImport(parsed){
 if(!parsed.rows.length)throw Error('No se reconocieron filas. Usa columnas Pregunta, '+pedagogy.dimensions.join(', ')+', separadas por | o tabuladores.');
 const panel=$('#ped-spec-review');if(!panel)return;
 const invalid=parsed.rows.filter(r=>r.number<1||r.number>state.draft.length).map(r=>r.number);
 if(invalid.length)parsed.warnings.push('Fuera de la numeración actual: '+invalid.join(', ')+'. Estas filas no se aplicarán.');
 pendingSpecRows=parsed.rows;pendingSpecExamId=state.exam.id;pendingSpecSignature=JSON.stringify(state.draft.map(q=>q.prompt));
 panel.innerHTML='<p class="notice warning">Revisa estas filas antes de aplicarlas. Los números se refieren al orden actual de las preguntas.</p>'+
 (parsed.warnings.length?'<p class="hint">'+esc(parsed.warnings.join(' · '))+'</p>':'')+
 '<div class="table-wrap"><table><thead><tr><th>Pregunta</th>'+pedagogy.dimensions.map(d=>'<th>'+esc(d)+'</th>').join('')+'</tr></thead><tbody>'+parsed.rows.map(r=>'<tr><td>'+r.number+'</td>'+r.tags.map(t=>'<td>'+esc(t||'—')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div><div class="btn-row"><button type="button" class="btn btn-green small" data-action="ped-spec-apply">Aplicar categorías</button><button type="button" class="btn btn-outline small" data-action="ped-spec-cancel">Cancelar</button></div>';
}
let pendingSpecRows=[],pendingSpecExamId=null,pendingSpecSignature='';

/* ============================ SUPERVISIÓN =========================== */
function scoring(student,snap,qs){let auto=0,max=0,open=0;for(const q of qs){if(q.kind==='short'){open++;continue}max+=Number(q.points);const resp=snap.answers.find(a=>a.participant_id===student.id&&a.question_id===q.id)?.response;const target=(q.correct||[]).map(Number).sort((a,b)=>a-b);const given=q.kind==='multi'?(Array.isArray(resp)?resp.map(Number).sort((a,b)=>a-b):[]):(resp===null||resp===undefined?[]:[Number(resp)]);if(target.length&&JSON.stringify(target)===JSON.stringify(given))auto+=Number(q.points)}return {auto,max,open};}
function countEvents(s,snap,kind){return (snap?.events||[]).filter(e=>e.participant_id===s.id&&e.kind===kind).length}
/* Supervisión: observaciones del navegador, nunca inferencias por demora. */
function supervisionReport(st,snap){
 const start=Date.parse(st.joined_at),end=Date.parse(st.submitted_at);
 const labels={hidden:'Pestaña o aplicación dejó de estar visible',blur:'Pérdida de foco (ventana, aplicación o control externo no identificado)',pagehide:'Salida, navegación o cierre de la página',fullscreen_exit:'Salida de pantalla completa',reload:'Recarga de la página'};
 const events=(snap?.events||[]).filter(e=>e.participant_id===st.id&&Object.prototype.hasOwnProperty.call(labels,e.kind)&&(!Number.isFinite(start)||Date.parse(e.occurred_at)>=start)&&(!Number.isFinite(end)||Date.parse(e.occurred_at)<=end)).sort((a,b)=>Date.parse(a.occurred_at)-Date.parse(b.occurred_at));
 const count=k=>events.filter(e=>e.kind===k).length;
 const hidden=count('hidden'),blur=count('blur'),pagehide=count('pagehide'),fullscreen=count('fullscreen_exit'),reload=count('reload');
 const status=hidden||pagehide?'Salida o pérdida de visibilidad registrada':blur||fullscreen?'Otras incidencias de foco o pantalla completa registradas':reload?'Recarga registrada; no se acreditó pérdida de visibilidad':'Sin incidencias de salida, foco o pantalla completa registradas';
 return {hidden,blur,pagehide,fullscreen,reload,status,events,labels};
}
function supervisionText(st,snap){
 const x=supervisionReport(st,snap);
 return 'Supervisión de la evaluación: '+x.status+'.\nPestaña no visible: '+x.hidden+'; pérdida de foco: '+x.blur+'; salida/navegación: '+x.pagehide+'; salida de pantalla completa: '+x.fullscreen+'; recargas: '+x.reload+'.\nNo se contabiliza la demora al responder. Los eventos pueden coincidir y no identifican otras aplicaciones ni prueban copia. La ausencia de eventos no garantiza que no hubo una salida.';
}
function supervisionHTML(st,snap){
 const x=supervisionReport(st,snap);
 return '<section class="ped-report-section supervision-report"><h2>Registro individual de supervisión</h2><p><b>'+esc(x.status)+'</b></p><div class="ped-kpis supervision-kpis">'+[['Pestaña no visible',x.hidden],['Pérdidas de foco',x.blur],['Salida/navegación',x.pagehide],['Pantalla completa',x.fullscreen],['Recargas',x.reload]].map(([n,v])=>'<div><span>'+esc(n)+'</span><strong>'+v+'</strong></div>').join('')+'</div>'+
 (x.events.length?'<div class="table-wrap"><table><thead><tr><th>Fecha y hora</th><th>Evento detectado</th></tr></thead><tbody>'+x.events.map(e=>'<tr><td>'+esc(new Date(e.occurred_at).toLocaleString('es-CL',{dateStyle:'short',timeStyle:'medium'}))+'</td><td>'+esc(x.labels[e.kind])+'</td></tr>').join('')+'</tbody></table></div>':'<p class="hint">No se recibieron eventos de estos tipos.</p>')+
 '<p class="hint">No se usa el tiempo de respuesta para determinar incidencias. Un mismo episodio puede generar varios eventos; no deben sumarse como salidas independientes. El navegador no identifica qué otra pestaña, aplicación o control del teléfono se utilizó. No constituye prueba de fraude.</p></section>';
}
function statusStudent(s,exam){if(s.submitted_at)return 'Entregada';if(exam.status==='closed')return 'Cerrada';if(Date.now()>new Date(s.joined_at).getTime()+exam.duration_minutes*60000)return 'Tiempo agotado';if(Date.now()-new Date(s.last_seen_at).getTime()>45000)return 'Sin conexión reciente';return 'En curso'}
async function dashboard(){setView('dashboard');const ex=state.exam;app.innerHTML='<div class="loading">Cargando panel docente…</div>';try{state.snapshot=await teacherSnapshot(ex);state.announcedIds=new Set((state.snapshot.events||[]).map(e=>String(e.id)));renderDashboard();refreshTimer=setInterval(()=>refreshDashboard().catch(console.error),5000);
 if(!isDemo){realtime=supa.channel(`qx-${ex.id}`).on('postgres_changes',{event:'*',schema:'public',table:'qx_events'},()=>refreshDashboard().catch(console.error)).on('postgres_changes',{event:'*',schema:'public',table:'qx_participants'},()=>refreshDashboard().catch(console.error)).subscribe()}}
 catch(e){err(e);teacherList()}}
async function refreshDashboard(){if(state.view!=='dashboard')return;
 const examId=state.exam.id;const next=await teacherSnapshot(state.exam);
 if(state.view!=='dashboard'||state.exam?.id!==examId)return;
 const fresh=(next.events||[]).filter(e=>['hidden','blur','pagehide','fullscreen_exit'].includes(e.kind)&&!state.announcedIds.has(String(e.id)));
 for(const e of next.events||[])state.announcedIds.add(String(e.id));
 state.snapshot=next;renderDashboard(true);
 if(fresh.length){const e=fresh[0],student=next.students.find(s=>s.id===e.participant_id);
   const msg=`${student?.name||'Un estudiante'}: ${e.kind==='fullscreen_exit'?'salió de pantalla completa':e.kind==='hidden'?'la prueba dejó de estar visible':e.kind==='blur'?'perdió el foco del navegador':'salió o navegó fuera de la página'}`;
   toast(fresh.length===1?msg:`${fresh.length} nuevas incidencias de supervisión`,6500);
   if('Notification' in window&&Notification.permission==='granted'){
     try{new Notification('AulaPrueba B-13 · Incidencia',{body:msg})}catch(ex){console.warn(ex)}
   }
 }
}
function renderDashboard(refresh=false){if(state.view!=='dashboard')return;const ex=state.exam,s=state.snapshot,students=s.students||[],events=s.events||[];const submitted=students.filter(x=>x.submitted_at).length,hidden=events.filter(e=>e.kind==='hidden').length,blurCount=events.filter(e=>e.kind==='blur').length,fullscreenExits=events.filter(e=>e.kind==='fullscreen_exit').length,online=students.filter(x=>!x.submitted_at&&Date.now()-new Date(x.last_seen_at).getTime()<=45000).length;const list=students.map(st=>{const grade=scoring(st,s,state.questions);const nota=st.submitted_at&&!grade.open?gradeOf(grade.auto,grade.max,exigenciaOf(ex)):null;const monitor=supervisionReport(st,s),eh=monitor.hidden,ef=monitor.fullscreen,eb=monitor.blur;return `<tr><td><b>${esc(st.name)}</b><div class="mini muted">${esc(st.curso||'Curso no registrado')} · N.º ${esc(st.numero_lista??'—')} · ${esc(st.email||'Sin correo registrado')}</div></td><td>${esc(statusStudent(st,ex))}</td><td>${grade.max?`${num(grade.auto)} / ${num(grade.max)}`:'—'}${grade.open?` <span class="muted mini">+ abiertas</span>`:''}${nota!==null?` <span class="muted mini">· Nota ${gradeLabel(nota)}</span>`:''}</td><td>${eh||ef||eb||monitor.pagehide||monitor.reload?`<span class="badge-alert">${esc(monitor.status)} · ${eh} no visible · ${eb} foco · ${monitor.pagehide} salida/navegación · ${ef} pantalla completa · ${monitor.reload} recargas</span>`:'Sin incidencias registradas'}</td><td>${fmt(st.last_seen_at)}</td><td><div class="btn-row"><button class="btn btn-ghost small" data-action="inspect" data-id="${st.id}">Detalle</button><button class="btn btn-outline small" data-action="prepare-email" data-id="${st.id}" ${!st.submitted_at||!st.email?'disabled':''}>Preparar correo</button><button class="btn btn-green small" data-action="send-email" data-id="${st.id}" ${!st.submitted_at||!st.email?'disabled':''}>Enviar resultado</button><button class="btn btn-danger small" data-action="remove-participant" data-id="${esc(st.id)}">Eliminar registro</button></div></td></tr>`}).join('');
 const labels={fullscreen_exit:'Abandonó pantalla completa',fullscreen_enter:'Restableció pantalla completa',hidden:'Pestaña no visible',visible:'Regresó a la pestaña',blur:'Perdió foco',focus:'Recuperó foco',offline:'Sin conexión del dispositivo',online:'Conexión recuperada',pagehide:'Salida/navegación',reload:'Recarga'};
 const incidents=events.slice(0,30).map(e=>{const st=students.find(s=>s.id===e.participant_id);return `<div class="event-row"><span><span class="event-label">${esc(st?.name||'Alumno')}</span> <span class="event-type">${esc(labels[e.kind]||e.kind)}</span></span><span class="event-time">${fmt(e.occurred_at)}</span></div>`}).join('');
 const detail=state.selectedStudent&&students.find(x=>x.id===state.selectedStudent);
 const detailHtml=detail?`<div class="card" style="margin-top:18px"><div class="subhead"><h2 class="section-title" style="margin:0">Respuestas de ${esc(detail.name)} <span class="mini muted">${esc(detail.curso||'Curso no registrado')} · N.º ${esc(detail.numero_lista??'—')} · ${esc(detail.email||'')}</span></h2><button class="btn btn-ghost small" data-action="close-inspect">Cerrar detalle</button></div>${supervisionHTML(detail,s)}${state.questions.map((q,i)=>{const a=s.answers.find(a=>a.participant_id===detail.id&&a.question_id===q.id);const answer=a? (q.kind==='short'?String(a.response??'') : Array.isArray(a.response)?a.response.map(n=>q.options?.[Number(n)]||'').join(' / '):q.options?.[Number(a.response)]||''):'Sin respuesta';return `<div style="border-top:1px solid #eef2f3;padding:14px 0"><div class="mini muted">Pregunta ${i+1} · ${num(q.points)} puntos</div><div style="margin:6px 0;font-weight:700;white-space:pre-wrap">${esc(q.prompt)}</div><div class="mini" style="white-space:pre-wrap">${esc(answer)}</div></div>`}).join('')}</div>`:'';
 app.innerHTML=`<div class="subhead"><div><div class="eyebrow">Supervisión docente · <span class="pill ${esc(ex.status)}">${statusLabel(ex.status)}</span></div><h1>${esc(ex.title)}</h1><div class="fixed-code"><span class="muted mini">Código de evaluación</span> <span class="code">${esc(ex.code)}</span> <button class="btn btn-ghost small" data-action="copy-link">Copiar enlace</button></div></div><div class="btn-row"><button class="btn btn-outline small" data-action="teacher-list">← Mis pruebas</button>${ex.status==='published'?'<button class="btn btn-danger small" data-action="close-exam">Cerrar prueba</button>':''}</div></div><div class="stats"><div class="stat"><span class="stat-label">Inscritos</span><span class="stat-number">${students.length}<span class="muted mini"> / 38</span></span></div><div class="stat"><span class="stat-label">Conexión reciente</span><span class="stat-number">${online}</span></div><div class="stat"><span class="stat-label">Entregadas</span><span class="stat-number">${submitted}</span></div><div class="stat"><span class="stat-label">Pestaña no visible (eventos)</span><span class="stat-number alert">${hidden}</span></div><div class="stat"><span class="stat-label">Pérdidas de foco</span><span class="stat-number">${blurCount}</span></div><div class="stat"><span class="stat-label">Salidas de pantalla completa</span><span class="stat-number alert">${fullscreenExits}</span></div></div><div class="toolbar"><button class="btn btn-green small" data-action="open-pedagogy">Análisis pedagógico</button><button class="btn btn-outline small" data-action="download-summary">Exportar resumen CSV</button><button class="btn btn-outline small" data-action="download-detail">Exportar respuestas CSV</button>${typeof Notification!=='undefined'&&Notification.permission!=='denied'?'<button class="btn btn-outline small" data-action="notify-enable">Avisos del navegador</button>':''}<span class="muted mini push">Actualización automática cada 5 segundos</span></div><div class="table-wrap"><table><thead><tr><th>Estudiante</th><th>Situación</th><th>Corrección automática</th><th>Incidencias</th><th>Última actividad</th><th></th></tr></thead><tbody>${list||'<tr><td colspan="6" class="empty">Aún no ingresan estudiantes.</td></tr>'}</tbody></table></div>${detailHtml}<div class="card" style="margin-top:20px"><div class="subhead"><h2 class="section-title" style="margin:0">Registro de eventos del navegador</h2><span class="muted mini">Los eventos de pérdida de foco pueden tener causas inocuas.</span></div>${incidents||'<div class="muted mini">Aún no hay eventos registrados.</div>'}</div><div class="notice warning" style="margin-top:18px">Un cambio de pestaña es un indicador técnico, no una prueba de copia. Las desconexiones, restricciones del sistema operativo y funciones de accesibilidad pueden afectar los registros. La corrección automática no incluye las preguntas abiertas.</div>`;insertExamQR(ex);}
function csvCell(v){let s=String(v??'');if(/^[=+@\-]/.test(s))s="'"+s;return `"${s.replace(/"/g,'""')}"`;}
function downloadCsv(name,rows){const content='\ufeff'+rows.map(row=>row.map(csvCell).join(';')).join('\r\n');const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));const a=el('a',{href:url,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1200)}
function exportSummary(){const e=state.exam,s=state.snapshot;const rows=[['Estudiante','Curso','Número de lista','Correo electrónico','Situación','Puntaje selección','Puntaje máximo selección','Preguntas abiertas pendientes','Pestaña oculta (eventos)','Salida de pantalla completa (eventos)','Pérdidas de foco (eventos)','Ingreso','Entrega','Salida/navegación (eventos)','Recarga (eventos)','Estado de supervisión']];for(const st of s.students){const x=scoring(st,s,state.questions);rows.push([st.name,st.curso||'',st.numero_lista??'',st.email||'',statusStudent(st,e),x.auto,x.max,x.open,countEvents(st,s,'hidden'),countEvents(st,s,'fullscreen_exit'),countEvents(st,s,'blur'),fmt(st.joined_at),fmt(st.submitted_at),supervisionReport(st,s).pagehide,supervisionReport(st,s).reload,supervisionReport(st,s).status])}downloadCsv(`resumen_${e.code}.csv`,rows)}
function exportDetail(){const e=state.exam,s=state.snapshot;const rows=[['Estudiante','Curso','Número de lista','Correo electrónico','Pregunta','Tipo','Enunciado','Respuesta','Puntos máximos','Respuesta correcta (pauta)','Fecha guardado']];for(const st of s.students)for(let i=0;i<state.questions.length;i++){const q=state.questions[i],a=s.answers.find(a=>a.participant_id===st.id&&a.question_id===q.id);const readable=val=>val===undefined||val===null?'':q.kind==='short'?String(val):Array.isArray(val)?val.map(n=>q.options?.[Number(n)]||'').join(' / '):q.options?.[Number(val)]||'';rows.push([st.name,st.curso||'',st.numero_lista??'',st.email||'',i+1,q.kind,q.prompt,a?readable(a.response):'',q.points,q.kind==='short'?'Corrección manual':q.correct.map(n=>q.options?.[Number(n)]||'').join(' / '),a?fmt(a.saved_at):''])}downloadCsv(`respuestas_${e.code}.csv`,rows)}


/* v5 · Informes docentes: el análisis no se entrega al estudiante automáticamente. */
let currentPedReport=null;
let currentPedIndividual=null;
let pedGradeReady=false;
const percentage=v=>v===null||!Number.isFinite(v)?'—':num(v)+' %';
function pedText(v){return esc(v??'')}
function pedBar(v){return v===null?'': '<span class="ped-bar"><i style="width:'+Math.max(0,Math.min(100,v))+'%"></i></span>'}
async function openPedagogicalPanel(){
 if(!state.teacher&&!isDemo)return;
 setView('pedagogy');app.innerHTML='<div class="loading">Cargando análisis pedagógico…</div>';
 try{
  state.questions=await teacherQuestions(state.exam);
  state.snapshot=await teacherSnapshot(state.exam);
  if(isDemo){pedagogicalGrades=[];pedGradeReady=false}
  else{
   const ids=state.questions.filter(q=>q.kind==='short').map(q=>q.id);
   if(ids.length&&pedagogy.ready){pedagogicalGrades=[];pedGradeReady=true;for(let start=0;;start+=500){const r=await supa.from('qx_manual_scores').select('participant_id,question_id,points').in('question_id',ids).order('participant_id').order('question_id').range(start,start+499);if(r.error){if(!missingPedagogy(r.error))throw r.error;pedagogicalGrades=[];pedGradeReady=false;break}pedagogicalGrades.push(...(r.data||[]));if((r.data||[]).length<500)break}}
   else{pedagogicalGrades=[];pedGradeReady=!!pedagogy.ready}
  }
  renderPedagogy();
 }catch(e){err(e);await dashboard()}
}
function pedFeedbackHTML(report){
 const f=feedback(report);
 const list=(groups,empty)=>groups.length?'<ul>'+groups.map(g=>'<li>'+pedText(g.dimension)+' · '+pedText(g.name)+' — '+percentage(g.pct)+' ('+g.questions.length+' ítem(s), '+g.n+' respuestas corregidas)</li>').join('')+'</ul>':'<p>'+empty+'</p>';
 return '<section class="ped-report-section"><h2>Retroalimentación pedagógica</h2><p>'+pedText(f.summary)+'</p><h3>Fortalezas</h3>'+list(f.strengths,'No se identificaron categorías que alcancen el umbral superior, o faltan datos.')+'<h3>Aprendizajes por reforzar</h3>'+list(f.needs,'No se identificaron categorías bajo el umbral inferior, o faltan datos.')+'<h3>Preguntas prioritarias</h3>'+(f.priority.length?'<ul>'+f.priority.map(i=>'<li>Pregunta '+i.number+' · '+percentage(i.pct)+' — '+pedText(i.q.prompt)+'</li>').join('')+'</ul>':'<p>No hay preguntas bajo el umbral inferior con puntaje calculable.</p>')+'<h3>Recomendaciones</h3><p>'+pedText(f.recommendation)+'</p><p class="hint">Los porcentajes describen desempeño en los ítems evaluados; no prueban causas ni equivalen por sí solos a dominio estable. Considera el número de ítems y las entregas pendientes.</p></section>';
}
function pedDimensionsHTML(r){
 return '<section class="ped-report-section"><h2>Logro por dimensión</h2>'+r.dimensions.map(d=>'<h3>'+pedText(d.name)+'</h3>'+(d.groups.length?'<div class="table-wrap"><table><thead><tr><th>Categoría</th><th>Preguntas</th><th>Puntos</th><th>Logro</th></tr></thead><tbody>'+d.groups.map(g=>'<tr><td>'+pedText(g.name)+'</td><td>'+g.questions.join(', ')+'</td><td>'+num(g.earned)+' / '+num(g.max)+'</td><td>'+percentage(g.pct)+pedBar(g.pct)+'</td></tr>').join('')+'</tbody></table></div>':'<p class="hint">Sin categorías corregidas en esta dimensión.</p>')).join('')+'</section>';
}
function pedSpecsHTML(){
 return '<section class="ped-report-section"><h2>Tabla de especificaciones</h2><div class="table-wrap"><table><thead><tr><th>Pregunta</th>'+dimensionsOf(pedagogy.dimensions).map(d=>'<th>'+pedText(d)+'</th>').join('')+'<th>Puntaje</th></tr></thead><tbody>'+state.questions.map((q,i)=>'<tr><td>'+(i+1)+'</td>'+tagsOf(q.categories).map(c=>'<td>'+pedText(c||'—')+'</td>').join('')+'<td>'+num(q.points)+'</td></tr>').join('')+'</tbody></table></div></section>';
}
function pedItemsHTML(r){
 return '<section class="ped-report-section"><h2>Análisis por pregunta y alternativa</h2>'+r.items.map(it=>{
  const q=it.q;
  const choices=q.kind==='short'?'':(q.options||[]).map((o,j)=>'<div class="ped-choice"><span>'+String.fromCharCode(65+j)+'. '+pedText(o)+((q.correct||[]).map(Number).includes(j)?' <b>(Correcta)</b>':'')+'</span><b>'+it.counts[j]+' · '+percentage(r.submitted?100*it.counts[j]/r.submitted:null)+'</b></div>').join('');
  return '<details class="ped-item"><summary>Pregunta '+it.number+' · '+percentage(it.pct)+' · '+it.blank+' en blanco · '+it.pending+' por corregir</summary><p>'+pedText(q.prompt)+'</p><p class="hint">Puntos corregidos: '+num(it.earned)+' / '+num(it.max)+' · '+it.graded+' respuestas corregidas.</p>'+choices+(q.kind==='multi'?'<p class="hint">En selección múltiple los porcentajes pueden sumar más de 100 %.</p>':'')+'</details>';
 }).join('')+'</section>';
}
function pedLessonHTML(r){
 const mins=pedagogicalLessonMinutes;
 const f=feedback(r),parts=[.1,.2,.25,.35,.1].map(x=>Math.floor(mins*x));parts[4]+=mins-parts.reduce((a,b)=>a+b,0);
 const steps=['Comunicar los resultados y el propósito del reforzamiento.','Revisar '+(f.priority.length?'las preguntas '+f.priority.map(i=>i.number).join(', '):'los ítems de menor logro')+' y comparar respuestas sin identificar estudiantes.','Modelar procedimientos de resolución y fundamentación.','Aplicar nuevas preguntas o tareas del mismo aprendizaje; revisar en parejas o individualmente.','Aplicar una pregunta de salida y registrar los aprendizajes que todavía requieren apoyo.'];
 return '<section class="ped-report-section"><h2>Propuesta de clase de retroalimentación · '+mins+' min</h2><div class="table-wrap"><table><thead><tr><th>Etapa</th><th>Minutos</th><th>Actividad sugerida</th></tr></thead><tbody>'+['Presentación','Análisis de errores','Modelamiento','Aplicación','Verificación'].map((n,i)=>'<tr><td>'+n+'</td><td>'+parts[i]+'</td><td>'+pedText(steps[i])+'</td></tr>').join('')+'</tbody></table></div><p class="hint">Propuesta editable mediante impresión o adaptación docente; requiere seleccionar textos y actividades apropiados para el curso.</p></section>';
}
function pedManualHTML(student){
 if(!student)return '';
 const qs=state.questions.filter(q=>q.kind==='short');
 if(!qs.length)return '';
 const map=new Map(pedagogicalGrades.map(g=>[g.participant_id+'|'+g.question_id,g.points]));
 return '<section class="card ped-no-print"><h2>Corrección de preguntas abiertas</h2>'+(!pedGradeReady?'<p class="notice warning">Activa la migración v5 para guardar los puntajes.</p>':'')+qs.map(q=>{
  const i=state.questions.indexOf(q),val=map.get(student.id+'|'+q.id);
  const answer=state.snapshot.answers.find(a=>a.participant_id===student.id&&a.question_id===q.id)?.response;
  return '<div class="ped-manual"><h3>Pregunta '+(i+1)+' · '+num(q.points)+' puntos</h3><p>'+pedText(q.prompt)+'</p><div class="notice" style="white-space:pre-wrap">'+pedText(answer??'Sin respuesta')+'</div><div class="btn-row"><input type="number" min="0" max="'+Number(q.points)+'" step="0.01" id="ped-grade-'+esc(q.id)+'" value="'+esc(val??'')+'" placeholder="Pendiente" '+(!pedGradeReady?'disabled':'')+'><button class="btn btn-outline small" data-action="ped-grade" data-qid="'+esc(q.id)+'" data-stid="'+esc(student.id)+'" '+(!pedGradeReady?'disabled':'')+'>Guardar puntaje</button></div></div>';
 }).join('')+'</section>';
}
function pedReportHTML(r,scope){
 const d=r.distribution,e=exigenciaOf(state.exam),grade=currentPedIndividual&&!r.pending?gradeOf(r.earned,r.max,e):null;
 return '<div id="ped-print-report"><section class="ped-report-section"><div class="eyebrow">Informe pedagógico · AulaPrueba B-13</div><h1>'+pedText(state.exam.title)+'</h1><p><b>'+pedText(scope)+'</b> · '+esc(new Date().toLocaleDateString('es-CL'))+'</p><div class="ped-kpis"><div><span>Logro sobre puntos corregidos</span><strong>'+percentage(r.pct)+'</strong></div><div><span>Entregas / inscritos</span><strong>'+r.submitted+' / '+r.enrolled+'</strong></div><div><span>Puntos corregidos</span><strong>'+num(r.earned)+' / '+num(r.max)+'</strong></div><div><span>Preguntas categorizadas</span><strong>'+r.classified+' / '+r.questionCount+'</strong></div></div>'+
 (r.pending?'<p class="notice warning">Informe provisional: '+r.pending+' respuestas o pautas pendientes de corrección. No se incluyen en el denominador corregido ni en la clasificación individual definitiva.</p>':'')+
 '<p class="hint">Se incluyen únicamente entregas confirmadas. Las respuestas omitidas en ítems cerrados se puntúan con cero. Cada dimensión se calcula por separado; no se suman porcentajes entre dimensiones.</p><p><b>Exigencia: '+e+' %'+(currentPedIndividual?' · Nota: '+gradeLabel(grade):'')+'</b></p>'+(currentPedIndividual?'<h3>Retroalimentación cualitativa individual</h3><p>'+esc(r.pending?'Pendiente de corrección definitiva.':qualitativeFeedback(r.earned,r.max,e))+'</p>':'')+'<h3>Niveles de logro (evaluaciones completas y corregidas)</h3><div class="ped-kpis"><div>Logrado ≥ '+r.high+' % <strong>'+d.high+'</strong></div><div>En desarrollo ≥ '+r.low+' % y &lt; '+r.high+' % <strong>'+d.middle+'</strong></div><div>Por reforzar &lt; '+r.low+' % <strong>'+d.low+'</strong></div><div>Sin clasificación definitiva <strong>'+d.excluded+'</strong></div></div></section>'+pedDimensionsHTML(r)+pedFeedbackHTML(r)+ (currentPedIndividual?supervisionHTML(currentPedIndividual,state.snapshot):pedLessonHTML(r))+pedItemsHTML(r)+pedSpecsHTML()+'</div>';
}
function renderPedagogy(){
 if(state.view!=='pedagogy')return;
 const all=state.snapshot.students||[],courses=[...new Set(all.map(st=>st.curso||'Sin curso registrado'))].sort();
 if(pedagogicalFilter&&!courses.includes(pedagogicalFilter))pedagogicalFilter='';
 const pool=all.filter(st=>!pedagogicalFilter||(st.curso||'Sin curso registrado')===pedagogicalFilter);
 const individual=pool.find(st=>st.id===pedagogicalStudent&&st.submitted_at);
 currentPedIndividual=individual||null;
 const chosen=individual?[individual]:pool;
 const report=analyze(state.questions,chosen,state.snapshot.answers||[],pedagogicalGrades,pedagogy.dimensions,pedagogicalLow,pedagogicalHigh);currentPedReport=report;
 const scope=individual?'Informe individual · '+individual.name+' · '+(individual.curso||'Sin curso'):pedagogicalFilter?'Informe del curso · '+pedagogicalFilter:'Informe general · todos los cursos inscritos';
 app.innerHTML='<div class="subhead ped-no-print"><div><div class="eyebrow">Área docente · Análisis pedagógico</div><h1>Resultados y retroalimentación</h1></div><button class="btn btn-outline" data-action="ped-back">← Supervisión</button></div>'+
 (!pedagogy.ready?'<p class="notice warning">La migración v5 aún no está activa. Se puede analizar la corrección automática existente, pero no guardar categorías ni corregir respuestas abiertas.</p>':'')+
 '<div class="card ped-controls ped-no-print"><div class="ped-category-grid"><div class="field"><label>Curso</label><select id="ped-course"><option value="">Todos los cursos</option>'+courses.map(c=>'<option value="'+esc(c)+'" '+(c===pedagogicalFilter?'selected':'')+'>'+esc(c)+'</option>').join('')+'</select></div><div class="field"><label>Estudiante</label><select id="ped-student"><option value="">Curso completo</option>'+pool.filter(st=>st.submitted_at).map(st=>'<option value="'+esc(st.id)+'" '+(st.id===pedagogicalStudent?'selected':'')+'>'+esc(st.name)+' · '+esc(st.numero_lista??'')+'</option>').join('')+'</select></div><div class="field"><label>Umbral inferior (%)</label><input id="ped-low" type="number" min="0" max="100" value="'+pedagogicalLow+'"></div><div class="field"><label>Umbral superior (%)</label><input id="ped-high" type="number" min="0" max="100" value="'+pedagogicalHigh+'"></div><div class="field"><label>Clase de retroalimentación (min)</label><input id="ped-minutes" type="number" min="10" max="180" value="'+pedagogicalLessonMinutes+'"></div></div><div class="btn-row"><button class="btn btn-green small" data-action="ped-apply-filters">Aplicar filtros</button><button class="btn btn-outline small" data-action="ped-refresh">Actualizar resultados</button><button class="btn btn-outline small" data-action="ped-print">Descargar informe PDF (2 páginas)</button><button class="btn btn-outline small" data-action="ped-csv">Exportar CSV pedagógico</button>'+(individual?'<button class="btn btn-outline small" data-action="ped-email" '+(!individual.email?'disabled':'')+'>Preparar correo de retroalimentación</button>':'')+'</div></div>'+
 pedManualHTML(individual)+pedReportHTML(report,scope)+
 (!individual&&report.individual.length?'<section class="card ped-no-print"><h2>Resultados individuales</h2><div class="table-wrap"><table><thead><tr><th>Estudiante</th><th>Curso</th><th>Logro corregido</th><th>Pendientes</th><th></th></tr></thead><tbody>'+report.individual.map(i=>'<tr><td>'+pedText(i.student.name)+'</td><td>'+pedText(i.student.curso||'—')+'</td><td>'+percentage(i.pct)+'</td><td>'+i.pending+'</td><td><button class="btn btn-outline small" data-action="ped-individual" data-id="'+esc(i.student.id)+'">Ver informe</button></td></tr>').join('')+'</tbody></table></div></section>':'');
}
function pedApplyFilters(){
 const low=Number($('#ped-low').value),high=Number($('#ped-high').value),mins=Number($('#ped-minutes').value);
 if(!Number.isFinite(low)||!Number.isFinite(high)||low<0||high>100||low>=high)throw Error('El umbral inferior debe ser menor al superior, entre 0 y 100.');
 if(!Number.isInteger(mins)||mins<10||mins>180)throw Error('La duración de clase debe estar entre 10 y 180 minutos.');
 pedagogicalLow=low;pedagogicalHigh=high;pedagogicalLessonMinutes=mins;
 const course=$('#ped-course').value;if(course!==pedagogicalFilter)pedagogicalStudent='';else pedagogicalStudent=$('#ped-student').value;
 pedagogicalFilter=course;renderPedagogy();
}
async function pedSaveGrade(stid,qid){
 const field=$('#ped-grade-'+qid),q=state.questions.find(x=>x.id===qid),st=state.snapshot.students.find(x=>x.id===stid&&x.submitted_at);
 if(!field||!q||q.kind!=='short'||!st||!pedGradeReady)throw Error('No se puede registrar el puntaje.');
 const raw=field.value.trim();
 if(raw===''){check(await supa.from('qx_manual_scores').delete().eq('participant_id',stid).eq('question_id',qid));}
 else{const pts=Number(raw);if(!Number.isFinite(pts)||pts<0||pts>Number(q.points))throw Error('Puntaje fuera de rango');check(await supa.from('qx_manual_scores').upsert({participant_id:stid,question_id:qid,points:pts},{onConflict:'participant_id,question_id'}));}
 await openPedagogicalPanel();toast('Corrección guardada.');
}
function pedCSV(){
 const r=currentPedReport;if(!r)return;
 const rows=[['Tipo','Estudiante / dimensión','Categoría / pregunta','Puntos obtenidos','Puntos máximos corregidos','Logro %','Pendientes','Detalle','Pestaña no visible','Pérdida de foco','Salida/navegación','Salida pantalla completa','Recarga','Estado de supervisión','Exigencia %','Nota']];
 for(const i of r.individual){const x=supervisionReport(i.student,state.snapshot);rows.push(['Individual',i.student.name,i.student.curso||'',i.earned,i.max,i.pct??'',i.pending,'',x.hidden,x.blur,x.pagehide,x.fullscreen,x.reload,x.status,exigenciaOf(state.exam),i.pending?'':gradeOf(i.earned,i.max,exigenciaOf(state.exam))??'']);}
 for(const d of r.dimensions)for(const g of d.groups)rows.push(['Dimensión',d.name,g.name,g.earned,g.max,g.pct??'','',g.questions.join(', ')]);
 for(const it of r.items)rows.push(['Pregunta','',it.number,it.earned,it.max,it.pct??'',it.pending,it.q.prompt]);
 downloadCsv('analisis_'+state.exam.code+'.csv',rows);
}

async function pedPrint(){
 const r=currentPedReport,st=currentPedIndividual,exam={...state.exam},snap=state.snapshot,course=pedagogicalFilter;
 if(!r)return;
 const {jsPDF}=await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm');
 const doc=new jsPDF({orientation:'portrait',unit:'mm',format:'a4'});
 const e=exigenciaOf(exam),f=feedback(r);
 const complete=r.individual.filter(i=>!i.pending&&i.max>0);
 const grades=complete.map(i=>gradeOf(i.earned,i.max,e));
 const clip=(v,n=140)=>{const t=String(v??'').replace(/\s+/g,' ').trim();return t.length>n?t.slice(0,n-3)+'...':t};
 let y=0;
 function line(value,size=10,maxLines=3,bold=false,color=[35,55,65]){
  doc.setFont('helvetica',bold?'bold':'normal');doc.setFontSize(size);doc.setTextColor(...color);
  let lines=doc.splitTextToSize(clip(value,900),180);
  if(lines.length>maxLines){lines=lines.slice(0,maxLines);lines[lines.length-1]=clip(lines[lines.length-1],Math.max(4,lines[lines.length-1].length-4))+'...'}
  if(y+lines.length*5>276)return;
  doc.text(lines,15,y);y+=lines.length*5+2;
 }
 function section(title){y+=3;line(title,12,1,true,[18,78,103]);doc.setDrawColor(207,223,229);doc.line(15,y-1,195,y-1);y+=2}
 function header(page){
  doc.setFillColor(18,59,74);doc.rect(0,0,210,3,'F');
  y=13;line('LICEO BICENTENARIO INDUSTRIAL RAMÓN BARROS LUCO',10,2,true,[18,78,103]);
  line('AulaPrueba B-13 | Creado por Ricardo Galup',8,1);
  line(st?'INFORME INDIVIDUAL':'INFORME GENERAL DEL CURSO',15,1,true);
  line(exam.title,12,2,true);
  line(st?st.name+' | '+(st.curso||'Sin curso')+' | Lista '+(st.numero_lista??'—'):(course||'Todos los cursos inscritos'),10,2);
  line('Fecha: '+new Date().toLocaleDateString('es-CL')+' | Exigencia: '+e+' %',9,1);
  doc.setFontSize(8);doc.setTextColor(90,105,110);doc.text('AulaPrueba B-13   |   Página '+page+' de 2',15,287);
 }
 header(1);
 section('Resultado y calificación');
 line('Puntaje '+(st?'':'acumulado del grupo: ')+num(r.earned)+' / '+num(r.max)+' puntos corregidos  |  Logro: '+percentage(r.pct),12,2,true);
 if(st)line('Nota: '+(r.pending?'Pendiente de corrección':gradeLabel(gradeOf(r.earned,r.max,e))),14,1,true);
 else {line('Entregas: '+r.submitted+' / '+r.enrolled+' | Nota promedio (correcciones completas): '+(grades.length?gradeLabel(grades.reduce((a,b)=>a+b,0)/grades.length):'Pendiente'),10,2);line('Notas definitivas: '+grades.length+' | Notas >= 4,0: '+grades.filter(n=>n>=4).length+' | Notas < 4,0: '+grades.filter(n=>n<4).length,10,2)}
 if(r.pending)line('Informe provisional: '+r.pending+' respuestas o pautas pendientes. No se asigna nota definitiva a correcciones incompletas.',9,2);
 section(st?'Retroalimentación individual':'Retroalimentación general');
 line(st?(r.pending?'La corrección está pendiente. La valoración definitiva se comunicará al completar la revisión.':qualitativeFeedback(r.earned,r.max,e)):f.summary,11,5);
 if(!st){line(f.recommendation,10,5)}
 section('Dimensiones: síntesis de resultados');
 const groups=r.dimensions.flatMap(d=>d.groups.filter(g=>g.pct!==null).map(g=>({...g,dimension:d.name})));
 const sorted=[...groups].sort((a,b)=>b.pct-a.pct);
 const highlights=[...sorted.slice(0,3),...sorted.slice(-3).filter(g=>!sorted.slice(0,3).includes(g))];
 if(!highlights.length)line('Sin categorías evaluadas con puntaje calculable.',10,2);
 else for(const g of highlights)line(clip(g.dimension,30)+' / '+clip(g.name,75)+' | '+percentage(g.pct)+' | '+g.questions.length+' ítem(s)',9,2);
 if(groups.length>highlights.length)line('Se muestra una síntesis de las categorías extremas; detalle completo en el panel docente y CSV.',8,2);
 doc.addPage();header(2);
 if(st){
  const x=supervisionReport(st,snap);
  section('Supervisión individual');
  line(x.status,11,2,true);
  line('Pestaña no visible: '+x.hidden+' | Pérdida de foco: '+x.blur+' | Salida/navegación: '+x.pagehide,10,2);
  line('Pantalla completa: '+x.fullscreen+' | Recargas: '+x.reload,10,2);
  for(const ev of x.events.slice(0,6))line(fmt(ev.occurred_at)+' | '+x.labels[ev.kind],9,2);
  if(x.events.length>6)line('Se muestran 6 de '+x.events.length+' eventos. Cronología completa en el panel docente.',9,2);
  line('No se contabiliza la demora. Los eventos pueden coincidir y no constituyen prueba de fraude.',9,3);
  section('Orientaciones para el aprendizaje');
  line('Refuerza los contenidos trabajados con ejercicios nuevos, fundamenta las respuestas y revisa tus procedimientos con el docente.',10,4);
  line('La pauta y el detalle de aciertos y errores no se incluyen en este informe resumido.',9,2);
 }else{
  section('Fortalezas y aprendizajes por reforzar');
  for(const g of f.strengths.slice(0,3))line('Fortaleza: '+clip(g.dimension,30)+' / '+clip(g.name,80)+' ('+percentage(g.pct)+')',10,2);
  for(const g of f.needs.slice(0,3))line('Reforzar: '+clip(g.dimension,30)+' / '+clip(g.name,80)+' ('+percentage(g.pct)+')',10,2);
  if(!f.strengths.length&&!f.needs.length)line('Sin categorías en los umbrales de fortaleza o reforzamiento.',10,2);
  section('Plan de retroalimentación');
  line('Preguntas prioritarias: '+(f.priority.map(i=>i.number).join(', ')||'Sin ítems bajo el umbral inferior.'),10,2);
  line('Presentar resultados, analizar dificultades, modelar estrategias, aplicar nuevas tareas y verificar aprendizajes. Duración sugerida: '+pedagogicalLessonMinutes+' minutos.',10,4);
 }
 line('Informe sintético (máximo 2 páginas A4). Los resultados detallados y las especificaciones permanecen disponibles en el panel docente.',8,3);
 doc.save('Informe_'+exam.code+'_'+(st?String(st.numero_lista??'individual'):'curso')+'.pdf');
}
function pedEmail(){
 const st=currentPedIndividual,r=currentPedReport;if(!st||!st.email||!r)throw Error('Selecciona un estudiante con correo.');
 if(state.exam.status!=='closed'&&!confirm('La evaluación todavía está abierta. ¿Preparar el informe sin incluir la pauta ni las respuestas correctas?'))return;
 if(r.pending&&!confirm('El informe contiene correcciones pendientes. ¿Preparar igualmente un correo provisional?'))return;
 if(!confirm('Comprueba que '+st.email+' pertenece a '+st.name+'. ¿Preparar el correo para revisarlo antes de enviarlo?'))return;
 const e=exigenciaOf(state.exam);
 const body=['AulaPrueba B-13 — '+state.exam.title,'Estudiante: '+st.name,'Puntaje: '+num(r.earned)+' / '+num(r.max)+(r.pending?' (corrección provisional)':''),'Exigencia: '+e+' %','Nota: '+(r.pending?'Pendiente':gradeLabel(gradeOf(r.earned,r.max,e))),r.pending?'La retroalimentación definitiva está pendiente.':qualitativeFeedback(r.earned,r.max,e)].join('\n');
 window.location.href='mailto:'+encodeURIComponent(st.email)+'?subject='+encodeURIComponent('Retroalimentación — '+state.exam.title)+'&body='+encodeURIComponent(body);
}

/* ============================= ESTUDIANTE ============================= */
function studentEntrance(codeOverride=null){
 setView('student-join');
 const supplied=(codeOverride||new URLSearchParams(location.search).get('code')||'').trim().toUpperCase();
 state.joinCode=supplied;
 if(!supplied){
  app.innerHTML=`<div class="narrow"><section class="hero"><div class="eyebrow">Acceso a la prueba</div><h1>Ingresar código de evaluación</h1><p>Si el profesor te envió un enlace directo, abre ese enlace. Si te entregó un código, escríbelo aquí.</p></section><div class="card"><form id="student-code-form"><div class="field"><label for="join-code">Código de evaluación</label><input id="join-code" required maxlength="10" autocomplete="off" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:.1em;font-weight:750" placeholder="DEMO38" /></div><button class="btn block" type="submit">Continuar</button></form></div></div>`;
  return;
 }
 const existing=safeSession('qx_session_'+supplied);
 app.innerHTML=`<div class="narrow"><section class="hero"><div class="eyebrow">Ingreso del estudiante</div><h1>Identificación para la evaluación</h1><p>Completa únicamente estos cuatro datos. No se requiere teléfono ni contraseña.</p></section><div class="card"><div class="notice"><b>Código de la evaluación</b> <span class="code">${esc(supplied)}</span></div><form id="student-join-form"><div class="field"><label for="join-name">Nombre y apellido</label><input id="join-name" minlength="3" maxlength="120" required autocomplete="name" value="${esc(existing?.name||'')}" placeholder="Nombre y apellido" /></div><div class="field"><label for="join-course">Curso</label><input id="join-course" minlength="2" maxlength="45" required autocomplete="off" value="${esc(existing?.curso||'')}" placeholder="Ej.: 2.º medio B" /></div><div class="field"><label for="join-list">Número de lista</label><input id="join-list" type="number" min="1" max="100" step="1" inputmode="numeric" required value="${esc(existing?.numero_lista??'')}" placeholder="Ej.: 13" /></div><div class="field"><label for="join-email">Correo electrónico (preferentemente del liceo)</label><input id="join-email" type="email" maxlength="254" autocomplete="email" required value="${esc(existing?.email||'')}" placeholder="nombre@liceo.cl" /><span class="hint">Utiliza tu correo institucional si tienes uno. Comprueba que esté bien escrito para recibir los resultados.</span></div><div class="notice">Al comenzar, se solicitará pantalla completa. El profesor podrá revisar las respuestas y los cambios de pestaña que el navegador consiga registrar.</div><button class="btn block" type="submit">Iniciar evaluación en pantalla completa</button></form><p class="hint">Una página web no puede bloquear por completo el uso de otras aplicaciones. El correo se registra sin verificación de propiedad.</p></div></div>`;
}
async function studentBegin(codeText,name,curso,numeroLista,email){
 const c=codeText.trim().toUpperCase(),n=name.trim().replace(/\s+/g,' '),course=curso.trim().replace(/\s+/g,' '),listNo=Number(numeroLista),mail=email.trim().toLowerCase();
 if(!c)throw Error('Falta el código de evaluación');
 if(!validFullName(n)||n.length>120)throw Error('Escribe nombre y apellido');
 if(!validCourse(course))throw Error('Introduce un curso válido');
 if(!validListNumber(listNo))throw Error('Introduce un número de lista entre 1 y 100');
 if(!validEmail(mail))throw Error('Escribe un correo electrónico válido');
 const saved=safeSession('qx_session_'+c);
 const matches=saved?.name?.toLocaleLowerCase('es-CL')===n.toLocaleLowerCase('es-CL')&&
  (!saved.curso||saved.curso.toLocaleLowerCase('es-CL')===course.toLocaleLowerCase('es-CL'))&&
  (saved.numero_lista==null||Number(saved.numero_lista)===listNo)&&saved?.email?.toLowerCase()===mail;
 const joined=await studentJoin(c,n,course,listNo,mail,matches?saved.token:null);
 for(const timer of pendingTimers.values())clearTimeout(timer);pendingTimers.clear();inFlight.clear();studentBusy=false;
 state.activeStudent={exam_id:joined.exam_id,token:joined.token,code:c,name:joined.name,curso:joined.curso||course,numero_lista:joined.numero_lista??listNo,email:joined.email||mail};
 localStorage.setItem('qx_session_'+c,JSON.stringify(state.activeStudent));
 studentLoad=await studentFetch(joined.exam_id,joined.token);
 serverClockOffset=Date.now()-new Date(studentLoad.participant.server_now).getTime();
 studentAnswers=new Map(studentLoad.answers.map(a=>[a.question_id,a.response]));deadlineSubmissionAttempted=false;resumeStudentPosition();renderStudent();
}

/* Navegación de una sola pregunta por pantalla, con posición persistida por sesión. */
function studentPositionKey(){
 if(!state.activeStudent)return null;
 return 'qx_position_'+state.activeStudent.exam_id+'_'+state.activeStudent.token;
}
function rememberStudentPosition(){
 const key=studentPositionKey();
 if(!key)return;
 try{localStorage.setItem(key,String(studentQuestionIndex))}catch(e){}
}
function resumeStudentPosition(){
 const key=studentPositionKey();
 const total=studentLoad?.questions?.length||0;
 let index=0;
 try{const stored=key?Number(localStorage.getItem(key)):0;if(Number.isInteger(stored))index=stored}catch(e){}
 studentQuestionIndex=Math.max(0,Math.min(total-1,index));
}
async function jumpToStudentQuestion(target){
 if(studentNavigating||studentBusy||state.view!=='student-exam')return;
 const total=studentLoad?.questions?.length||0;
 if(!Number.isInteger(target)||target<0||target>=total)return;
 studentNavigating=true;
 try{
   if(studentRemaining()<=0){toast('El tiempo de la evaluación ya terminó.');return;}
   await flushAnswers();
   studentQuestionIndex=target;
   rememberStudentPosition();
   renderStudent();
   window.scrollTo({top:0,behavior:'instant'});
 }catch(e){err(e)}
 finally{studentNavigating=false}
}
async function moveStudentQuestion(delta){return jumpToStudentQuestion(studentQuestionIndex+delta)}

function studentRemaining(){return Math.max(0,Math.floor((new Date(studentLoad.participant.expires_at).getTime()-(Date.now()-serverClockOffset))/1000));}

function exigenciaOf(exam){const n=Number(exam?.exigencia??60);return Number.isInteger(n)&&n>=1&&n<=99?n:60}
function gradeOf(earned,maximum,exigencia=60){if(!(maximum>0)||!Number.isFinite(Number(earned)))return null;const p=Math.min(1,Math.max(0,earned/maximum)),e=exigencia/100;return Math.round(10*(p<=e?1+3*p/e:4+3*(p-e)/(1-e)) + 1e-9)/10}
function gradeLabel(n){return n===null?'Pendiente':Number(n).toLocaleString('es-CL',{minimumFractionDigits:1,maximumFractionDigits:1})}
function qualitativeFeedback(earned,maximum,exigencia=60){
 if(!(maximum>0))return 'El resultado aún no permite emitir una valoración definitiva.';
 const p=100*earned/maximum;
 if(p>=Math.max(85,exigencia))return 'Demuestras un desempeño sólido en el conjunto de aprendizajes evaluados. Para seguir avanzando, profundiza la fundamentación de tus decisiones y aplica lo aprendido en situaciones nuevas.';
 if(p>=exigencia)return 'Alcanzas el nivel de exigencia de la evaluación. Conviene consolidar los aprendizajes mediante práctica variada, revisión de tus procedimientos y justificación de tus decisiones.';
 if(p>=exigencia*.7)return 'Tu desempeño muestra avances, aunque todavía requiere consolidación para alcanzar el nivel esperado. Revisa los contenidos trabajados, practica de manera guiada y verifica tu comprensión antes de responder.';
 return 'Necesitas reforzar los aprendizajes evaluados de forma progresiva. Retoma los conceptos centrales, trabaja con ejemplos guiados y solicita apoyo para revisar tus estrategias de resolución.';
}
async function loadImmediateResult(){
 const session=state.activeStudent;
 if(!session||!studentLoad?.participant.submitted_at)return {available:false};
 if(isDemo){
  const d=db(),ex=d.exams.find(e=>e.id===session.exam_id),st=d.students.find(x=>x.exam_id===session.exam_id&&x.token===session.token);
  const qs=d.questions.filter(q=>q.exam_id===session.exam_id);
  if(!st?.submitted_at||ex?.resultado_inmediato===false||!qs.length||qs.some(q=>q.kind==='short'||!q.correct?.length))return {available:false};
  const maximum=qs.reduce((sum,q)=>sum+Number(q.points),0),earned=qs.reduce((sum,q)=>sum+(scoreItem(q,d.answers.find(a=>a.participant_id===st.id&&a.question_id===q.id)?.response,null)??0),0);
  return {available:maximum>0,earned,maximum,exigencia:exigenciaOf(ex)};
 }
 const r=await supa.rpc('qx_student_result',{p_exam:session.exam_id,p_token:session.token});
 if(r.error){if(missingPedagogy(r.error))return {available:false,reason:'migration'};throw r.error}
 return r.data;
}
async function displayImmediateResult(){
 const session=state.activeStudent,root=$('#immediate-result');if(!root||!session)return;
 root.textContent='Consultando resultado…';
 try{
  const r=await loadImmediateResult();
  if(state.view!=='student-done'||state.activeStudent?.token!==session.token||!root.isConnected)return;
  if(!r?.available){root.innerHTML='<p class="hint">'+(r?.reason==='migration'?'Resultado inmediato aún no habilitado por el docente.': 'El profesor comunicará el resultado cuando esté disponible.')+'</p>';return}
  const earned=Number(r.earned),max=Number(r.maximum),e=exigenciaOf(r),grade=gradeOf(earned,max,e);
  root.innerHTML='<div class="result-kpis"><div><span>Puntaje</span><strong>'+num(earned)+' / '+num(max)+'</strong></div><div><span>Nota</span><strong>'+gradeLabel(grade)+'</strong></div></div><p class="hint">Exigencia: '+e+' %</p><section class="result-feedback"><h2>Retroalimentación individual</h2><p>'+esc(qualitativeFeedback(earned,max,e))+'</p></section>';
 }catch(e){if(root.isConnected){root.innerHTML='<p class="hint">La entrega está registrada, pero no se pudo consultar el resultado.</p><button class="btn btn-outline small" data-action="retry-result">Consultar nuevamente</button>'}}
}

function studentDone(){const key=studentPositionKey();if(key){try{localStorage.removeItem(key)}catch(e){}}setView('student-done');if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});app.innerHTML=`<div class="narrow"><div class="card" style="text-align:center;padding:50px 28px"><div class="choice-icon student" style="margin:0 auto 16px">✓</div><h1 style="font-size:27px">Entrega registrada</h1><p class="muted">${esc(studentLoad?.participant.name||'Estudiante')}, tu prueba ha sido enviada. El profesor podrá revisar tus respuestas y las incidencias registradas.</p><div id="immediate-result" aria-live="polite"></div><button class="btn btn-outline" data-action="home" style="margin-top:16px">Volver al inicio</button></div></div>`;void displayImmediateResult();}
function renderStudent(){if(studentLoad.participant.submitted_at)return studentDone();setView('student-exam');const ex=studentLoad.exam,qs=studentLoad.questions;studentQuestionIndex=Math.max(0,Math.min(qs.length-1,studentQuestionIndex));const answered=qs.filter(q=>studentAnswers.has(q.id)&&valueAnswered(studentAnswers.get(q.id),q.kind)).length;const expired=studentRemaining()===0||ex.status!=='published';app.innerHTML=`<div id="fullscreen-banner" class="fullscreen-banner hidden" role="alert"><div><b>Pantalla completa desactivada</b><p>Para continuar, presiona «Restablecer pantalla completa». Esta salida puede quedar registrada como incidencia.</p></div><button class="btn btn-green" data-action="restore-fullscreen">Restablecer pantalla completa</button></div><div class="student-header"><div><span class="eyebrow" style="color:#91c7c8">${esc(studentLoad.participant.name)} · <span id="fullscreen-status">Pantalla completa</span></span><h1>${esc(ex.title)}</h1><p>${esc(ex.description||'Responde todas las preguntas. Los cambios de pestaña se registran.')}</p></div><div class="timer" id="timer">--:--<small>Tiempo restante</small></div></div><div class="student-content"><div class="student-progress-top"><span class="student-step">Pregunta ${qs.length?studentQuestionIndex+1:0} de ${qs.length}</span><span class="muted mini" id="progress-label">${answered} de ${qs.length} respondidas</span></div><div class="progressbar"><div id="progress-fill" style="width:${qs.length?answered/qs.length*100:0}%"></div></div>${expired?'<div class="notice danger-notice">El tiempo finalizó o el profesor cerró la prueba. Ya no es posible cambiar las respuestas.</div>':''}${qs.length?questionStudentHTML(qs[studentQuestionIndex],studentQuestionIndex,expired):'<div class="notice warning">Esta evaluación todavía no contiene preguntas.</div>'}<div class="exam-footer student-navigation"><button class="btn btn-outline" data-action="student-prev" ${studentQuestionIndex===0?'disabled':''}>← Anterior</button><span class="answer-status" id="save-state">${expired?'Tiempo finalizado':'Guardado automático activado'}</span>${studentQuestionIndex===qs.length-1?'<button class="btn btn-green" data-action="submit-student" id="submit-btn">Finalizar y entregar</button>':'<button class="btn btn-green" data-action="student-next" id="student-next-btn">Siguiente →</button>'}</div></div>`;
 fullscreenBanner();tickTimer();studentTimer=setInterval(tickTimer,1000);if(!expired){studentPing().catch(console.error);heartbeatTimer=setInterval(()=>studentPing().catch(console.error),20000)} }
function valueAnswered(v,kind){return kind==='multi'?Array.isArray(v)&&v.length>0:kind==='short'?typeof v==='string'&&!!v.trim():v!==null&&v!==undefined;}
function questionStudentHTML(q,i,disabled){const ans=studentAnswers.get(q.id);const label=q.kind==='short'?'Respuesta abierta':q.kind==='multi'?'Puede marcar más de una alternativa':'Elija una alternativa';let body='';if(q.kind==='short')body=`<textarea class="input" style="min-height:110px;resize:vertical" data-student-q="${q.id}" data-kind="short" ${disabled?'disabled':''} placeholder="Escriba su respuesta aquí">${esc(ans??'')}</textarea>`;else body=q.options.map((opt,j)=>{const checked=q.kind==='multi'?Array.isArray(ans)&&ans.includes(j):ans===j;return `<label class="option"><input type="${q.kind==='multi'?'checkbox':'radio'}" name="question_${q.id}" value="${j}" data-student-q="${q.id}" data-kind="${q.kind}" ${checked?'checked':''} ${disabled?'disabled':''}/><span><b>${String.fromCharCode(65+j)}.</b> ${esc(opt)}</span></label>`}).join('');return `<article class="card question-card"><div class="question-prefix">PREGUNTA ${i+1} DE ${studentLoad.questions.length} · ${num(q.points)} PUNTOS</div><h2 class="question-title" style="white-space:pre-line">${esc(q.prompt)}</h2><div class="hint" style="margin-bottom:10px">${label}</div>${body}</article>`;}

async function submitWhenTimeEnds() {
 if(deadlineSubmissionAttempted || studentBusy || studentLoad?.participant.submitted_at) return;
 deadlineSubmissionAttempted = true;
 studentBusy = true;
 const button = $('#submit-btn');
 if(button) button.disabled = true;
 for(const t of pendingTimers.values()) clearTimeout(t);
 pendingTimers.clear();
 if($('#save-state')) $('#save-state').textContent = 'Tiempo agotado. Registrando entrega automática…';
 try {
   await Promise.allSettled([...inFlight.values()]);
   await studentSubmit();
   studentLoad.participant.submitted_at = iso();
   studentDone();
   toast('Tiempo agotado. Tu prueba se entregó automáticamente.',6000);
 } catch(e) {
   console.error('No se pudo confirmar la entrega automática',e);
   if($('#save-state')) $('#save-state').textContent = 'Tiempo agotado. No se pudo confirmar la entrega: comprueba tu conexión y pulsa Entregar prueba.';
   if(button) button.disabled = false;
   toast('No se confirmó la entrega automática. Intenta entregar la prueba.',8000);
 } finally { studentBusy = false; }
}

function tickTimer(){if(state.view!=='student-exam')return;const rem=studentRemaining(),t=$('#timer');if(!t)return;const h=Math.floor(rem/3600),m=Math.floor(rem%3600/60),s=rem%60;t.innerHTML=`${h?`${String(h).padStart(2,'0')}:`:''}${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}<small>Tiempo restante</small>`;t.classList.toggle('low',rem<=300);if(rem===0){clearInterval(studentTimer);document.querySelectorAll('[data-student-q]').forEach(n=>n.disabled=true);if(!studentBusy)void submitWhenTimeEnds()}}
function progress(){const n=studentLoad.questions.filter(q=>studentAnswers.has(q.id)&&valueAnswered(studentAnswers.get(q.id),q.kind)).length;$('#progress-label').textContent=`${n} de ${studentLoad.questions.length} respondidas`;$('#progress-fill').style.width=`${studentLoad.questions.length?n/studentLoad.questions.length*100:0}%`}
function queueAnswer(questionId,value){studentAnswers.set(questionId,value);progress();if($('#save-state'))$('#save-state').textContent='Guardando…';clearTimeout(pendingTimers.get(questionId));pendingTimers.set(questionId,setTimeout(()=>{pendingTimers.delete(questionId);persistAnswer(questionId,value).catch(err)},550))}
function persistAnswer(qid,value){const session=state.activeStudent;const previous=inFlight.get(qid)||Promise.resolve();const next=previous.catch(()=>{}).then(()=>{if(!session||state.activeStudent?.token!==session.token)throw Error('La sesión anterior ya no está activa.');return studentSave(qid,value)}).then(()=>{if($('#save-state')&&state.view==='student-exam'&&state.activeStudent?.token===session?.token)$('#save-state').textContent='Respuestas guardadas';}).catch(ex=>{if(isRevokedSession(ex))invalidateStudentSession(session);if($('#save-state')&&state.activeStudent?.token===session?.token)$('#save-state').textContent='Error al guardar: compruebe su conexión';throw ex});inFlight.set(qid,next);return next}
async function flushAnswers(){for(const [qid,t] of pendingTimers){clearTimeout(t);pendingTimers.delete(qid);await persistAnswer(qid,studentAnswers.get(qid))}await Promise.all([...inFlight.values()]);}
function unansweredStudentQuestions(){
 if(!studentLoad?.questions)return [];
 return studentLoad.questions.flatMap((q,index)=>valueAnswered(studentAnswers.get(q.id),q.kind)?[]:[index]);
}
function closeSubmitReview(){
 const review=$('#submit-review');
 if(!review)return;
 review.remove();
 $('#submit-btn')?.focus();
}
function showSubmitReview(){
 if(studentBusy||studentNavigating||state.view!=='student-exam'||$('#submit-review'))return;
 const pending=unansweredStudentQuestions(),total=studentLoad.questions.length;
 const answered=total-pending.length;
 const dialog=document.createElement('div');
 dialog.id='submit-review';
 dialog.className='submit-review-backdrop';
 dialog.innerHTML=`<section class="submit-review-dialog card" role="dialog" aria-modal="true" aria-labelledby="submit-review-heading" aria-describedby="submit-review-description">
  <div class="eyebrow">Revisión antes de entregar</div>
  <h2 id="submit-review-heading">${pending.length?'Tienes preguntas sin responder':'Todas las preguntas están respondidas'}</h2>
  <p id="submit-review-description">${pending.length?
   `Has respondido <b>${answered} de ${total}</b> preguntas. Aún faltan <b>${pending.length}</b>. Puedes ir a contestarlas o enviar la prueba de todas maneras.`:
   `Has respondido las <b>${total}</b> preguntas. ¿Confirmas la entrega definitiva?`}</p>
  ${pending.length?`<div class="submit-review-pending"><div class="submit-review-subtitle">Preguntas pendientes</div><div class="submit-review-numbers" aria-label="Preguntas sin responder">${pending.map(i=>`<button type="button" class="submit-review-number" data-action="student-jump-pending" data-index="${i}" aria-label="Ir a responder pregunta ${i+1}">${i+1}</button>`).join('')}</div><p class="hint">Selecciona un número para ir directamente a esa pregunta.</p></div>`:''}
  <p class="submit-review-warning">Una vez entregada la evaluación, no podrás modificar tus respuestas.</p>
  <div class="submit-review-actions">
   <button type="button" class="btn btn-outline" data-action="${pending.length?'student-review-pending':'student-cancel-submit'}">${pending.length?'Ir a contestar':'Volver a la prueba'}</button>
   <button type="button" class="btn btn-green" data-action="student-confirm-submit">${pending.length?'Enviar de todas maneras':'Confirmar entrega'}</button>
  </div>
  <button type="button" class="submit-review-close" data-action="student-cancel-submit" aria-label="Cerrar confirmación">×</button>
 </section>`;
 app.appendChild(dialog);
 dialog.querySelector('.submit-review-dialog')?.setAttribute('tabindex','-1');
 dialog.querySelector('.submit-review-dialog')?.focus();
}
async function submitStudentAnswers(){
 if(studentBusy||studentLoad?.participant.submitted_at)return;
 studentBusy=true;
 closeSubmitReview();
 const b=$('#submit-btn');if(b)b.disabled=true;
 try{
  let lateChanges=false;
  try{await flushAnswers()}catch(saveError){
   if(studentRemaining()>0&&studentLoad.exam.status==='published')throw saveError;
   lateChanges=true;
  }
  await studentSubmit();
  studentLoad.participant.submitted_at=iso();
  clearInterval(studentTimer);
  studentDone();
  toast(lateChanges?'Entrega confirmada; algunas modificaciones posteriores al plazo no se guardaron':'Entrega confirmada');
 }catch(e){err(e);if(b)b.disabled=false}
 finally{studentBusy=false}
}
async function finalizeStudent(){showSubmitReview()}

/* ============================== UI EVENTS ============================== */
document.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b)return;const a=b.dataset.action;try{
 if(a==='retry-result'){await displayImmediateResult();return}if(a==='home'){viewHome();return}if(a==='teacher'){await teacherEntrance();return}if(a==='student'){studentEntrance();return}if(a==='teacher-list'){await teacherList();return}if(a==='new-exam'){await newExam();return}if(a==='open-exam'){await openExam(b.dataset.id);return}
 if(a==='duplicate-exam'){b.disabled=true;try{await duplicateExam(b.dataset.id)}finally{b.disabled=false}return}
 if(a==='remove-participant'){b.disabled=true;try{await removeParticipant(b.dataset.id)}finally{b.disabled=false}return}
 if(a==='delete-exam'){b.disabled=true;try{await deleteExam(b.dataset.id)}finally{b.disabled=false}return}
 if(a==='export-exam-script'){await exportSavedExamScript(b.dataset.id);return}
 if(a==='pdf-apply'){applyPDFReview();return}
 if(a==='pdf-cancel'){pendingPdf=null;$('#pdf-review').innerHTML='';setImportStatus('exam','Importación cancelada.');return}
 if(a==='generate-script'){if(importBusy||pendingPdf?.examId===state.exam.id)throw Error('Incorpora o cancela el PDF pendiente antes de generar el script.');collectDraft();showScriptExport(generateGoogleScript(state.exam,state.draft,pedagogy.dimensions),state.exam.title);return}
 if(a==='copy-generated-script'){const t=$('#generated-script');if(t){await navigator.clipboard.writeText(t.value);toast('Script copiado.')}return}
 if(a==='download-generated-script'){const t=$('#generated-script');if(t){const u=URL.createObjectURL(new Blob([t.value],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=u;link.download='evaluacion-aulaprueba.gs';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(u),1000)}return}
 if(a==='close-script-export'){app.querySelector('.exam-script-modal')?.remove();return}
 if(a==='add-question'){collectDraft();state.draft.push(draftQuestion());editor();return}if(a==='remove-question'){collectDraft();state.draft.splice(Number(b.dataset.i),1);editor();return}
 if(a==='save-draft'){b.disabled=true;await saveDraft(false);return}if(a==='publish'){b.disabled=true;await saveDraft(true);return}
 if(a==='import-script'){collectDraft();const text=$('#script-input').value,qs=parseAppsScript(text);const names=importDimensionNames(text);if(names&&qs.length){pedagogy.dimensions=names;names.forEach((n,i)=>{const el=$('#ped-dim-'+i);if(el)el.value=n})}addImported(qs,'Google Apps Script');return}
 if(a==='ped-dim-refresh'){collectDraft();editor();return}
 if(a==='ped-spec-preview'){collectDraft();showSpecPreview();return}
 if(a==='ped-spec-paste'){collectDraft();previewSpecImport(parseSpecificationTable($('#spec-table').value,pedagogy.dimensions));return}
 if(a==='ped-spec-apply'){collectDraft();if(pendingSpecExamId!==state.exam.id||pendingSpecSignature!==JSON.stringify(state.draft.map(q=>q.prompt)))throw Error('Las preguntas cambiaron desde la vista previa. Vuelve a importar la tabla.');const r=applyImportedSpecs(state.draft,pendingSpecRows);pendingSpecRows=[];setImportStatus('spec',r.matched+' filas aplicadas.'+(r.miss.length?' No vinculadas: '+r.miss.join(', '):''));editor();showSpecPreview(r.matched+' filas aplicadas.'+(r.miss.length?' No vinculadas: '+r.miss.join(', '):''));return}
 if(a==='ped-spec-cancel'){pendingSpecRows=[];pendingSpecExamId=null;$('#ped-spec-review').innerHTML='';setImportStatus('spec','Importación cancelada.');return}
 if(a==='duration-preset'){const field=$('#exam-duration');if(field){field.value=b.dataset.minutes;field.focus()}return}
  if(a==='download-qr'){downloadExamQR();toast('Código QR descargado');return}
  if(a==='copy-link'){const url=examJoinUrl(state.exam);await navigator.clipboard.writeText(url);toast('Enlace de ingreso copiado');return}
 if(a==='open-pedagogy'){pedagogicalFilter='';pedagogicalStudent='';await openPedagogicalPanel();return}
 if(a==='ped-back'){await dashboard();return}
 if(a==='ped-apply-filters'){pedApplyFilters();return}
 if(a==='ped-refresh'){await openPedagogicalPanel();return}
 if(a==='ped-individual'){pedagogicalStudent=b.dataset.id;renderPedagogy();return}
 if(a==='ped-grade'){b.disabled=true;await pedSaveGrade(b.dataset.stid,b.dataset.qid);return}
 if(a==='ped-csv'){pedCSV();return}
 if(a==='ped-print'){await pedPrint();return}
 if(a==='ped-email'){pedEmail();return}
 if(a==='close-exam'){if(!confirm('¿Cerrar la prueba? Los estudiantes ya no podrán modificar respuestas.'))return;state.exam=await teacherUpdate(state.exam,{status:'closed'});renderDashboard();toast('Prueba cerrada');return}
 if(a==='inspect'){state.selectedStudent=b.dataset.id;renderDashboard(true);return}if(a==='close-inspect'){state.selectedStudent=null;renderDashboard(true);return}
 if(a==='notify-enable'){if('Notification' in window){const permission=await Notification.requestPermission();toast(permission==='granted'?'Avisos activados. Mantenga este panel abierto.':'No se otorgó permiso de notificaciones.')}return}
 if(a==='prepare-email'){prepareMail(b.dataset.id);return}if(a==='send-email'){b.disabled=true;try{await sendMail(b.dataset.id)}finally{b.disabled=false}return}
 if(a==='restore-fullscreen'){const ok=await askFullscreen();if(!ok)toast('Tu navegador no permitió pantalla completa. El profesor puede ver que está desactivada.');fullscreenBanner();return}
 if(a==='download-summary'){exportSummary();return}if(a==='download-detail'){exportDetail();return}
 if(a==='student-prev'){await moveStudentQuestion(-1);return}if(a==='student-next'){await moveStudentQuestion(1);return}
  if(a==='student-cancel-submit'){closeSubmitReview();return}
  if(a==='student-review-pending'){const pending=unansweredStudentQuestions();closeSubmitReview();if(pending.length)await jumpToStudentQuestion(pending[0]);return}
  if(a==='student-jump-pending'){const target=Number(b.dataset.index);closeSubmitReview();await jumpToStudentQuestion(target);return}
  if(a==='student-confirm-submit'){await submitStudentAnswers();return}
  if(a==='submit-student'){await finalizeStudent();return}
 }catch(ex){err(ex);b.disabled=false}});
app.addEventListener('submit',async e=>{e.preventDefault();const form=e.target;
 if(form.id==='login-form'){const btn=form.querySelector('button[type=submit]');btn.disabled=true;try{const email=$('#email').value.trim().toLowerCase();if(!validEmail(email))throw Error('Escribe un correo electrónico válido');const redirect=new URL(location.pathname,location.origin);redirect.searchParams.set('docente','1');check(await supa.auth.signInWithOtp({email,options:{emailRedirectTo:redirect.toString(),shouldCreateUser:false}}));app.innerHTML='<div class="narrow card"><h2>Revisa tu correo electrónico</h2><p>Te enviamos un enlace para ingresar al panel docente sin contraseña. Si no llega, revisa la carpeta de correo no deseado.</p><button class="btn btn-outline" data-action="home">Volver al inicio</button></div>';toast('Enlace solicitado. Revisa tu correo electrónico.',6000)}catch(ex){err(ex)}finally{btn.disabled=false}}
 if(form.id==='student-code-form'){studentEntrance($('#join-code').value);return}
 if(form.id==='student-join-form'){const btn=form.querySelector('button[type=submit]');btn.disabled=true;try{const fullRequest=askFullscreen();await studentBegin(state.joinCode,$('#join-name').value,$('#join-course').value,$('#join-list').value,$('#join-email').value);const full=await fullRequest;if(!full)toast('El navegador no permitió pantalla completa. Usa el botón para intentarlo de nuevo.');fullscreenBanner()}catch(ex){err(ex);btn.disabled=false;if(document.fullscreenElement&&state.view==='student-join')document.exitFullscreen().catch(()=>{})}}});
app.addEventListener('change',async e=>{
 if(e.target.dataset.pdfIndex!==undefined&&pendingPdf?.examId===state.exam?.id){const index=Number(e.target.dataset.pdfIndex);if(e.target.checked)pendingPdf.excluded.delete(index);else pendingPdf.excluded.add(index);const n=$('#pdf-selected-count');if(n)n.textContent=(pendingPdf.parsed.questions.length-pendingPdf.excluded.size)+' de '+pendingPdf.parsed.questions.length+' preguntas seleccionadas.';return}
 if(e.target.dataset.importKind&&e.target.files?.[0]){const input=e.target,file=input.files[0],kind=input.dataset.importKind;input.value='';await importDroppedFile(kind,file);return}
 if(e.target.dataset.field==='kind'){const node=e.target.closest('.question-editor');node.querySelectorAll('.choice-config').forEach(x=>x.classList.toggle('hidden',e.target.value==='short'))}
 if(e.target.dataset.studentQ&&e.target.dataset.kind!=='short'){const qid=e.target.dataset.studentQ,kind=e.target.dataset.kind;let response=kind==='multi'?[...app.querySelectorAll(`[data-student-q="${qid}"]:checked`)].map(x=>Number(x.value)):Number(e.target.value);queueAnswer(qid,response)}});
// Evitar que arrastrar un archivo al editor navegue fuera de la página.
app.addEventListener('dragover',e=>{if(state.view!=='editor'||!Array.from(e.dataTransfer?.types||[]).includes('Files'))return;e.preventDefault();const zone=e.target.closest('[data-drop-kind]');if(zone){zone.classList.add('file-drop-active');e.dataTransfer.dropEffect='copy'}});
app.addEventListener('dragleave',e=>{const zone=e.target.closest('[data-drop-kind]');if(zone&&!zone.contains(e.relatedTarget))zone.classList.remove('file-drop-active')});
app.addEventListener('drop',e=>{if(state.view!=='editor'||!e.dataTransfer?.files?.length)return;e.preventDefault();const zone=e.target.closest('[data-drop-kind]');app.querySelectorAll('.file-drop-active').forEach(n=>n.classList.remove('file-drop-active'));if(!zone){toast('Suelta el archivo en el cuadro correspondiente.');return}if(e.dataTransfer.files.length!==1){toast('Carga un archivo a la vez.');return}void importDroppedFile(zone.dataset.dropKind,e.dataTransfer.files[0])});
app.addEventListener('input',e=>{if(e.target.dataset.studentQ&&e.target.dataset.kind==='short')queueAnswer(e.target.dataset.studentQ,e.target.value)});
$('#home-btn').addEventListener('click',viewHome);$('#go-home').addEventListener('click',viewHome);$('#logout-btn').addEventListener('click',async()=>{try{await supa?.auth.signOut();state.teacher=null;viewHome()}catch(ex){err(ex)}});

// Fullscreen no bloquea el dispositivo. Se registra la salida cuando el navegador lo notifica.
document.addEventListener('fullscreenchange',()=>{
 const active=isExamInProgress(),now=!!document.fullscreenElement;
 if(active&&wasFullscreen&&!now)studentEvent('fullscreen_exit');
 if(active&&!wasFullscreen&&now)studentEvent('fullscreen_enter');
 wasFullscreen=now;fullscreenBanner();
});
// Eventos solo durante una prueba no entregada.
document.addEventListener('visibilitychange',()=>{studentEvent(document.hidden?'hidden':'visible')});
window.addEventListener('blur',()=>studentEvent('blur'));
window.addEventListener('focus',()=>studentEvent('focus'));
window.addEventListener('offline',()=>studentEvent('offline'));
window.addEventListener('online',()=>studentEvent('online'));
window.addEventListener('pagehide',()=>{if(!isExamInProgress())return;
 if(isDemo){const d=db(),s=d.students.find(s=>s.exam_id===state.activeStudent.exam_id&&s.token===state.activeStudent.token);if(s){d.events.push({id:Date.now(),participant_id:s.id,kind:'pagehide',occurred_at:iso()});putDb(d)}return}
 // keepalive intenta entregar el evento incluso al navegar. No ofrece garantía de recepción.
 const endpoint=cfg.supabaseUrl.replace(/\/$/,'')+'/rest/v1/rpc/qx_student_event';const key=cfg.publishableKey;
 const headers={'content-type':'application/json',apikey:key};if(key.startsWith('eyJ'))headers.Authorization='Bearer '+key;
 try{fetch(endpoint,{method:'POST',keepalive:true,headers,body:JSON.stringify({p_exam:state.activeStudent.exam_id,p_token:state.activeStudent.token,p_kind:'pagehide'})}).catch(()=>{})}catch(e){}
});
window.addEventListener('storage',()=>{if(isDemo&&state.view==='dashboard')refreshDashboard().catch(console.error)});

async function init(){try{if(!isDemo){const {createClient}=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');supa=createClient(cfg.supabaseUrl,cfg.publishableKey);const {data:{user}}=await supa.auth.getUser();state.teacher=user||null;}else db();$('#mode-tag').textContent=isDemo?'Demostración local':'Conectado a Supabase';const params=new URLSearchParams(location.search);if(params.has('code'))studentEntrance();else if(params.get('docente')==='1')teacherEntrance();else studentEntrance();}catch(ex){console.error(ex);app.innerHTML=`<div class="card narrow"><h2>No se pudo iniciar la aplicación</h2><p class="muted">${esc(ex?.message||ex)}</p><p>Compruebe la configuración de Supabase y su conexión.</p></div>`}}
init();
