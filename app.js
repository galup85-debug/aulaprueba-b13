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
  `Entrega: ${fmt(student.submitted_at)}\n\n`+
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
function setView(view){stopUpdates();state.view=view;if(!['student-join','student-exam'].includes(view)&&document.fullscreenElement)document.exitFullscreen().catch(()=>{});$('#home-btn').classList.toggle('hidden',view==='student-join');$('#logout-btn').classList.toggle('hidden',!(state.teacher&&!isDemo&&['teacher-list','editor','dashboard'].includes(view)));}
function viewHome(){studentEntrance();}

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
async function teacherQuestions(exam){if(isDemo)return copy(db().questions.filter(q=>q.exam_id===exam.id).sort((a,b)=>a.position-b.position));return check(await supa.from('qx_questions').select('*').eq('exam_id',exam.id).order('position'));}
async function teacherReplaceQuestions(exam,items){if(isDemo){const d=db();d.questions=d.questions.filter(q=>q.exam_id!==exam.id);d.questions.push(...items.map((q,i)=>({...q,id:uid(),exam_id:exam.id,position:i})));putDb(d);return items.length}
 return check(await supa.rpc('qx_replace_questions',{p_exam:exam.id,p_questions:items}));}
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
 try{await supa.rpc('qx_student_event',{p_exam:state.activeStudent.exam_id,p_token:state.activeStudent.token,p_kind:kind})}catch(e){console.warn('Evento no enviado',e)}
}
async function studentPing(){if(!state.activeStudent||state.view!=='student-exam'||studentLoad?.participant.submitted_at)return;if(isDemo){const d=db(),s=d.students.find(s=>s.exam_id===state.activeStudent.exam_id&&s.token===state.activeStudent.token);if(s){s.last_seen_at=iso();putDb(d)}return}await supa.rpc('qx_student_ping',{p_exam:state.activeStudent.exam_id,p_token:state.activeStudent.token})}
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
 try{state.exams=await teacherExams();app.innerHTML=`<div class="subhead"><div><div class="eyebrow">Área docente</div><h1>Mis evaluaciones</h1><p class="muted mini">Cree una prueba y comparta su código cuando esté publicada.</p></div><button class="btn" data-action="new-exam">+ Nueva prueba</button></div><div class="exam-list">${state.exams.length?state.exams.map(e=>`<article class="exam-row"><div><h3>${esc(e.title)} <span class="pill ${esc(e.status)}">${statusLabel(e.status)}</span></h3><div class="exam-meta"><span>Código <b>${esc(e.code)}</b></span><span>Tiempo máximo: ${e.duration_minutes} min</span><span>${fmt(e.created_at)}</span></div></div><div class="btn-row"><button class="btn btn-outline small" data-action="open-exam" data-id="${e.id}">${e.status==='draft'?'Editar':'Supervisar'}</button></div></article>`).join(''):'<div class="card empty">Todavía no has creado una evaluación.</div>'}</div>`;}catch(e){err(e);viewHome()}}
function statusLabel(s){return ({draft:'Borrador',published:'Publicada',closed:'Cerrada'})[s]||s}
function draftQuestion(){return {kind:'single',prompt:'',options:['','','',''],correct:[],points:1};}
async function newExam(){const e={title:'Nueva evaluación',description:'',code:code(),duration_minutes:60,status:'draft'};try{state.exam=await teacherCreate(e);state.questions=[];state.draft=[draftQuestion()];editor()}catch(ex){err(ex)}}
async function openExam(id){const exam=state.exams.find(x=>x.id===id)||state.exam;if(!exam)return;state.exam=exam;try{state.questions=await teacherQuestions(exam);state.draft=copy(state.questions);if(exam.status==='draft'){if(!state.draft.length)state.draft=[draftQuestion()];editor()}else dashboard()}catch(e){err(e)}}
function editor(){setView('editor');const ex=state.exam;app.innerHTML=`<div class="subhead"><div><div class="eyebrow">Editor de pruebas · Borrador</div><h1>Configurar evaluación</h1></div><button class="btn btn-ghost" data-action="teacher-list">← Mis evaluaciones</button></div><div class="form-columns"><section><div class="card" style="margin-bottom:19px"><div class="field"><label for="exam-title">Título de la evaluación</label><input id="exam-title" maxlength="200" value="${esc(ex.title)}" /></div><div class="field"><label for="exam-description">Instrucciones para los estudiantes</label><textarea id="exam-description">${esc(ex.description)}</textarea></div><div class="field"><label for="exam-duration">Tiempo máximo para rendir la prueba (minutos)</label><input type="number" min="1" max="300" id="exam-duration" value="${ex.duration_minutes}" /><p class="hint">De 1 a 300 minutos. Comienza con el primer ingreso de cada estudiante y no se reinicia al actualizar la página. Al finalizar, se bloquean las respuestas y se registra la entrega.</p><div class="btn-row exam-duration-presets"><button type="button" class="btn btn-outline small" data-action="duration-preset" data-minutes="30">30 min</button><button type="button" class="btn btn-outline small" data-action="duration-preset" data-minutes="45">45 min</button><button type="button" class="btn btn-outline small" data-action="duration-preset" data-minutes="60">60 min</button><button type="button" class="btn btn-outline small" data-action="duration-preset" data-minutes="90">90 min</button><button type="button" class="btn btn-outline small" data-action="duration-preset" data-minutes="120">120 min</button></div></div><div class="field"><label>Código de acceso</label><span class="code">${esc(ex.code)}</span></div></div><div class="subhead"><h2 class="section-title" style="margin:0">Preguntas <span class="pill">${state.draft.length}</span></h2><button class="btn btn-outline small" data-action="add-question">+ Añadir pregunta</button></div><div class="stack" id="question-editors">${state.draft.map(questionEditorHTML).join('')}</div><div class="btn-row" style="margin-top:22px"><button class="btn btn-outline" data-action="save-draft">Guardar borrador</button><button class="btn btn-green" data-action="publish">Guardar y publicar</button></div></section><aside><div class="import-card"><h3>Importar desde PDF</h3><p class="hint">Extrae texto de PDF digitales y propone preguntas de selección múltiple. Debes revisar la pauta y el formato.</p><label class="btn btn-outline small" style="display:inline-block" for="pdf-file">Seleccionar PDF</label><input type="file" accept="application/pdf" id="pdf-file" class="hidden-file" /><div id="pdf-info" class="hint" style="margin-top:9px"></div></div><div class="import-card" style="margin-top:15px"><h3>Importar Google Apps Script</h3><p class="hint">Pega el código que construye un Google Form. Se interpreta como texto, sin ejecutarlo.</p><div class="field"><textarea id="script-input" placeholder="const item = form.addMultipleChoiceItem();\nitem.setTitle('...')..." style="min-height:142px">${esc(state.importText)}</textarea></div><button class="btn btn-outline small" data-action="import-script">Analizar script</button></div><div class="notice warning" style="margin-top:15px">La extracción de PDF no incluye OCR para páginas escaneadas. Preguntas con imágenes, tablas o columnas pueden requerir edición manual. Las respuestas correctas no se deducen del PDF.</div></aside></div>`;insertExamQR(ex);}
function questionEditorHTML(q,i){const options=Array.isArray(q.options)?q.options:[];const correct=Array.isArray(q.correct)?q.correct.map(x=>Number(x)+1).join(', '):'';return `<article class="question-editor" data-q="${i}"><div class="editor-top"><h3>Pregunta ${i+1}</h3><button class="btn btn-ghost small" data-action="remove-question" data-i="${i}">Eliminar</button></div><div class="field"><label>Enunciado</label><textarea data-field="prompt" placeholder="Escriba el enunciado">${esc(q.prompt)}</textarea></div><div class="editor-grid"><div class="field"><label>Tipo de pregunta</label><select data-field="kind"><option value="single" ${q.kind==='single'?'selected':''}>Selección única</option><option value="multi" ${q.kind==='multi'?'selected':''}>Selección múltiple</option><option value="short" ${q.kind==='short'?'selected':''}>Respuesta abierta</option></select></div><div class="field"><label>Puntaje</label><input type="number" min="0" max="100" step="0.5" data-field="points" value="${esc(q.points)}" /></div></div><div class="field choice-config ${q.kind==='short'?'hidden':''}"><label>Alternativas (una por línea)</label><textarea data-field="options" rows="5" placeholder="Alternativa A&#10;Alternativa B&#10;Alternativa C">${esc(options.join('\n'))}</textarea><span class="hint">Sin letras A, B, C ni numeración. Se agregarán automáticamente.</span></div><div class="field choice-config ${q.kind==='short'?'hidden':''}"><label>Alternativa(s) correcta(s)</label><input data-field="correct" value="${esc(correct)}" placeholder="Ej.: 2, o 1, 3 para selección múltiple" /><span class="hint">Ingrese el número de la alternativa, comenzando por 1. Es obligatorio antes de publicar.</span></div></article>`;}
function collectDraft(){const container=$('#question-editors');if(!container)return;state.draft=[...container.querySelectorAll('[data-q]')].map(node=>{const get=k=>node.querySelector(`[data-field="${k}"]`)?.value??'';let options=get('options').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);let kind=get('kind');let correct=[...new Set(get('correct').split(/[,;\s]+/).map(x=>Number(x)).filter(n=>Number.isInteger(n)&&n>0).map(n=>n-1))].sort((a,b)=>a-b);return {kind,prompt:get('prompt').trim(),points:Number(get('points')),options:kind==='short'?[]:options,correct:kind==='short'?[]:correct}});state.importText=$('#script-input')?.value||state.importText;}
function validateDraft(publicar=false){const title=$('#exam-title')?.value.trim()||state.exam.title,minutes=Number($('#exam-duration')?.value);if(title.length<3)throw Error('Escriba un título de al menos 3 caracteres');if(!Number.isInteger(minutes)||minutes<1||minutes>300)throw Error('La duración debe estar entre 1 y 300 minutos');if(publicar&&!state.draft.length)throw Error('Añada al menos una pregunta');for(let i=0;i<state.draft.length;i++){const q=state.draft[i];if(!q.prompt)throw Error(`Falta el enunciado de la pregunta ${i+1}`);if(!Number.isFinite(q.points)||q.points<0||q.points>100)throw Error(`Puntaje inválido en pregunta ${i+1}`);if(q.kind!=='short'){if(q.options.length<2||q.options.length>10)throw Error(`La pregunta ${i+1} necesita entre 2 y 10 alternativas`);if(q.correct.some(n=>n>=q.options.length))throw Error(`Revise la pauta de la pregunta ${i+1}`);if(publicar&&q.correct.length===0)throw Error(`Indique la alternativa correcta en la pregunta ${i+1}`);if(q.kind==='single'&&q.correct.length>1)throw Error(`La pregunta ${i+1} solo admite una respuesta correcta`)}}}
async function saveDraft(publicar=false){collectDraft();validateDraft(publicar);const ex=state.exam;const patch={title:$('#exam-title').value.trim(),description:$('#exam-description').value,duration_minutes:Number($('#exam-duration').value)};state.exam=await teacherUpdate(ex,patch);await teacherReplaceQuestions(state.exam,state.draft);state.questions=await teacherQuestions(state.exam);if(publicar){state.exam=await teacherUpdate(state.exam,{status:'published'});toast('Prueba publicada y disponible para los estudiantes');return dashboard()}toast('Borrador guardado correctamente');state.draft=copy(state.questions);editor();}

/* ============================= IMPORTACIÓN ============================= */
function parseTextQuestions(text){const lines=text.replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean);const qs=[];let current=null,lastOption=-1;
const qre=/^(?:(?:pregunta|ítem|item)\s*)?(\d{1,3})\s*[.)\-:]\s*(.+)$/i;
const ore=/^([a-jA-J])\s*[.)\-:]\s*(.+)$/;
for(const ln of lines){const qmatch=ln.match(qre),omatch=ln.match(ore);if(qmatch){if(current)qs.push(current);current={kind:'single',prompt:qmatch[2],options:[],correct:[],points:1};lastOption=-1;continue}if(omatch&&current){current.options.push(omatch[2]);lastOption=current.options.length-1;continue}if(current){if(lastOption>=0)current.options[lastOption]+=' '+ln;else current.prompt+=' '+ln}}
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
        if (typeof prompt !== 'string' || !Array.isArray(choices) || choices.length < 2 || choices.length > 10 || !choices.every(x => typeof x === 'string')) continue;
        let options = choices.map(s => s.trim());
        const hasLetters = options.every((s,i) => new RegExp('^' + String.fromCharCode(65+i) + '[\\)\\.\\:\\-]\\s+', 'i').test(s));
        if (hasLetters) options = options.map((s,i) => s.replace(new RegExp('^' + String.fromCharCode(65+i) + '[\\)\\.\\:\\-]\\s+', 'i'), ''));
        let correct = item.correcta ?? item.respuestaCorrecta ?? item.correct ?? item.correctas;
        const normalize = x => typeof x === 'number' ? x : typeof x === 'string' && /^[A-J]$/i.test(x.trim()) ? x.toUpperCase().charCodeAt(0)-65 : null;
        correct = (Array.isArray(correct) ? correct : [correct]).map(normalize).filter(x => Number.isInteger(x) && x >= 0 && x < options.length);
        const points = Number(item.puntos ?? item.puntaje ?? item.points ?? 1);
        const showHeading = heading && heading !== lastHeading;
        result.push({kind:correct.length>1?'multi':'single', prompt:(showHeading ? heading+'\n\n' : '')+prompt.trim(), options, correct, points:Number.isFinite(points)?points:1});
        if (heading) lastHeading = heading;
      }
    }
    visit(data);
    if (result.length) return result;
  }
  return result;
}

function parseAppsScript(src){const dataQuestions=parseQuestionsFromData(src);if(dataQuestions.length)return dataQuestions;const headers=[...src.matchAll(/add(MultipleChoice|Checkbox|Text|ParagraphText)Item\s*\(\s*\)/g)];const qs=[];
for(let i=0;i<headers.length;i++){const h=headers[i], chunk=src.slice(h.index+(h[0]||'').length,headers[i+1]?.index??src.length);const kind=h[1]==='MultipleChoice'?'single':h[1]==='Checkbox'?'multi':'short';const titleChunk=chunk.match(/\.setTitle\s*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1\s*\)/);if(!titleChunk)continue;let opts=[];let correct=[];const choices=chunk.match(/\.setChoiceValues\s*\(\s*\[([\s\S]*?)\]\s*\)/);
if(choices)opts=quotedStrings(choices[1]);else{const choiceR=/\.createChoice\s*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1\s*(?:,\s*(true|false))?\s*\)/g;for(const match of chunk.matchAll(choiceR)){opts.push(decodeJS(match[2]));if(match[3]==='true')correct.push(opts.length-1)}}
const pt=chunk.match(/\.setPoints\s*\(\s*(\d+(?:\.\d+)?)\s*\)/);qs.push({kind,prompt:decodeJS(titleChunk[2]),options:kind==='short'?[]:opts,correct,points:pt?Number(pt[1]):1})}
return qs.filter(q=>q.kind==='short'||q.options.length>=2);}
async function pdfRead(file){if(file.size>15*1024*1024)throw Error('PDF demasiado grande (máximo 15 MB)');const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs';const buf=await file.arrayBuffer();const pdf=await pdfjs.getDocument({data:buf}).promise;if(pdf.numPages>100)throw Error('Este importador admite PDF de hasta 100 páginas');let text='';for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i),tc=await page.getTextContent(),rows=new Map();for(const it of tc.items){if(!it.str)continue;const y=Math.round(it.transform?.[5]||0),x=it.transform?.[4]||0;let row=rows.get(y);if(!row){row=[];rows.set(y,row)}row.push({x,s:it.str})}text+=[...rows.entries()].sort((a,b)=>b[0]-a[0]).map(([y,r])=>r.sort((a,b)=>a.x-b.x).map(it=>it.s).join(' ').trim()).join('\n')+'\n'}return text;}
function addImported(items,source){if(!items.length)throw Error('No se detectaron preguntas compatibles. Revise el formato y agréguelas manualmente');collectDraft();if(state.draft.length===1&&!state.draft[0].prompt)state.draft=[];state.draft.push(...items.slice(0,100-state.draft.length));editor();toast(`${items.length} pregunta(s) importadas desde ${source}. Revise cada alternativa y su pauta.`,6000);}

/* ============================ SUPERVISIÓN =========================== */
function scoring(student,snap,qs){let auto=0,max=0,open=0;for(const q of qs){if(q.kind==='short'){open++;continue}max+=Number(q.points);const resp=snap.answers.find(a=>a.participant_id===student.id&&a.question_id===q.id)?.response;const target=(q.correct||[]).map(Number).sort((a,b)=>a-b);const given=q.kind==='multi'?(Array.isArray(resp)?resp.map(Number).sort((a,b)=>a-b):[]):(resp===null||resp===undefined?[]:[Number(resp)]);if(target.length&&JSON.stringify(target)===JSON.stringify(given))auto+=Number(q.points)}return {auto,max,open};}
function countEvents(s,snap,kind){return snap.events.filter(e=>e.participant_id===s.id&&e.kind===kind).length}
function statusStudent(s,exam){if(s.submitted_at)return 'Entregada';if(exam.status==='closed')return 'Cerrada';if(Date.now()>new Date(s.joined_at).getTime()+exam.duration_minutes*60000)return 'Tiempo agotado';if(Date.now()-new Date(s.last_seen_at).getTime()>45000)return 'Sin conexión reciente';return 'En curso'}
async function dashboard(){setView('dashboard');const ex=state.exam;app.innerHTML='<div class="loading">Cargando panel docente…</div>';try{state.snapshot=await teacherSnapshot(ex);state.announcedIds=new Set((state.snapshot.events||[]).map(e=>String(e.id)));renderDashboard();refreshTimer=setInterval(()=>refreshDashboard().catch(console.error),5000);
 if(!isDemo){realtime=supa.channel(`qx-${ex.id}`).on('postgres_changes',{event:'*',schema:'public',table:'qx_events'},()=>refreshDashboard().catch(console.error)).on('postgres_changes',{event:'*',schema:'public',table:'qx_participants'},()=>refreshDashboard().catch(console.error)).subscribe()}}
 catch(e){err(e);teacherList()}}
async function refreshDashboard(){if(state.view!=='dashboard')return;
 const next=await teacherSnapshot(state.exam);
 const fresh=(next.events||[]).filter(e=>['hidden','fullscreen_exit'].includes(e.kind)&&!state.announcedIds.has(String(e.id)));
 for(const e of next.events||[])state.announcedIds.add(String(e.id));
 state.snapshot=next;renderDashboard(true);
 if(fresh.length){const e=fresh[0],student=next.students.find(s=>s.id===e.participant_id);
   const msg=e.kind==='fullscreen_exit'?`${student?.name||'Un estudiante'}: salió del modo de pantalla completa`:`${student?.name||'Un estudiante'}: la pestaña de la prueba dejó de estar visible`;
   toast(fresh.length===1?msg:`${fresh.length} nuevas incidencias de supervisión`,6500);
   if('Notification' in window&&Notification.permission==='granted'){
     try{new Notification('AulaPrueba B-13 · Incidencia',{body:msg})}catch(ex){console.warn(ex)}
   }
 }
}
function renderDashboard(refresh=false){if(state.view!=='dashboard')return;const ex=state.exam,s=state.snapshot,students=s.students||[],events=s.events||[];const submitted=students.filter(x=>x.submitted_at).length,hidden=events.filter(e=>e.kind==='hidden').length,blurCount=events.filter(e=>e.kind==='blur').length,fullscreenExits=events.filter(e=>e.kind==='fullscreen_exit').length,online=students.filter(x=>!x.submitted_at&&Date.now()-new Date(x.last_seen_at).getTime()<=45000).length;const list=students.map(st=>{const grade=scoring(st,s,state.questions);const eh=countEvents(st,s,'hidden'),ef=countEvents(st,s,'fullscreen_exit'),eb=countEvents(st,s,'blur');return `<tr><td><b>${esc(st.name)}</b><div class="mini muted">${esc(st.curso||'Curso no registrado')} · N.º ${esc(st.numero_lista??'—')} · ${esc(st.email||'Sin correo registrado')}</div></td><td>${esc(statusStudent(st,ex))}</td><td>${grade.max?`${num(grade.auto)} / ${num(grade.max)}`:'—'}${grade.open?` <span class="muted mini">+ abiertas</span>`:''}</td><td>${eh||ef||eb?`<span class="badge-alert">${eh} pestaña no visible · ${eb} pérdidas de foco · ${ef} salidas de pantalla completa</span>`:'0'}</td><td>${fmt(st.last_seen_at)}</td><td><div class="btn-row"><button class="btn btn-ghost small" data-action="inspect" data-id="${st.id}">Detalle</button><button class="btn btn-outline small" data-action="prepare-email" data-id="${st.id}" ${!st.submitted_at||!st.email?'disabled':''}>Preparar correo</button><button class="btn btn-green small" data-action="send-email" data-id="${st.id}" ${!st.submitted_at||!st.email?'disabled':''}>Enviar resultado</button></div></td></tr>`}).join('');
 const labels={fullscreen_exit:'Abandonó pantalla completa',fullscreen_enter:'Restableció pantalla completa',hidden:'Pestaña no visible',visible:'Regresó a la pestaña',blur:'Perdió foco',focus:'Recuperó foco',offline:'Sin conexión del dispositivo',online:'Conexión recuperada',pagehide:'Salida/navegación',reload:'Recarga'};
 const incidents=events.slice(0,30).map(e=>{const st=students.find(s=>s.id===e.participant_id);return `<div class="event-row"><span><span class="event-label">${esc(st?.name||'Alumno')}</span> <span class="event-type">${esc(labels[e.kind]||e.kind)}</span></span><span class="event-time">${fmt(e.occurred_at)}</span></div>`}).join('');
 const detail=state.selectedStudent&&students.find(x=>x.id===state.selectedStudent);
 const detailHtml=detail?`<div class="card" style="margin-top:18px"><div class="subhead"><h2 class="section-title" style="margin:0">Respuestas de ${esc(detail.name)} <span class="mini muted">${esc(detail.curso||'Curso no registrado')} · N.º ${esc(detail.numero_lista??'—')} · ${esc(detail.email||'')}</span></h2><button class="btn btn-ghost small" data-action="close-inspect">Cerrar detalle</button></div>${state.questions.map((q,i)=>{const a=s.answers.find(a=>a.participant_id===detail.id&&a.question_id===q.id);const answer=a? (q.kind==='short'?String(a.response??'') : Array.isArray(a.response)?a.response.map(n=>q.options?.[Number(n)]||'').join(' / '):q.options?.[Number(a.response)]||''):'Sin respuesta';return `<div style="border-top:1px solid #eef2f3;padding:14px 0"><div class="mini muted">Pregunta ${i+1} · ${num(q.points)} puntos</div><div style="margin:6px 0;font-weight:700;white-space:pre-wrap">${esc(q.prompt)}</div><div class="mini" style="white-space:pre-wrap">${esc(answer)}</div></div>`}).join('')}</div>`:'';
 app.innerHTML=`<div class="subhead"><div><div class="eyebrow">Supervisión docente · <span class="pill ${esc(ex.status)}">${statusLabel(ex.status)}</span></div><h1>${esc(ex.title)}</h1><div class="fixed-code"><span class="muted mini">Código de evaluación</span> <span class="code">${esc(ex.code)}</span> <button class="btn btn-ghost small" data-action="copy-link">Copiar enlace</button></div></div><div class="btn-row"><button class="btn btn-outline small" data-action="teacher-list">← Mis pruebas</button>${ex.status==='published'?'<button class="btn btn-danger small" data-action="close-exam">Cerrar prueba</button>':''}</div></div><div class="stats"><div class="stat"><span class="stat-label">Inscritos</span><span class="stat-number">${students.length}<span class="muted mini"> / 38</span></span></div><div class="stat"><span class="stat-label">Conexión reciente</span><span class="stat-number">${online}</span></div><div class="stat"><span class="stat-label">Entregadas</span><span class="stat-number">${submitted}</span></div><div class="stat"><span class="stat-label">Pestaña no visible (eventos)</span><span class="stat-number alert">${hidden}</span></div><div class="stat"><span class="stat-label">Pérdidas de foco</span><span class="stat-number">${blurCount}</span></div><div class="stat"><span class="stat-label">Salidas de pantalla completa</span><span class="stat-number alert">${fullscreenExits}</span></div></div><div class="toolbar"><button class="btn btn-outline small" data-action="download-summary">Exportar resumen CSV</button><button class="btn btn-outline small" data-action="download-detail">Exportar respuestas CSV</button>${typeof Notification!=='undefined'&&Notification.permission!=='denied'?'<button class="btn btn-outline small" data-action="notify-enable">Avisos del navegador</button>':''}<span class="muted mini push">Actualización automática cada 5 segundos</span></div><div class="table-wrap"><table><thead><tr><th>Estudiante</th><th>Situación</th><th>Corrección automática</th><th>Incidencias</th><th>Última actividad</th><th></th></tr></thead><tbody>${list||'<tr><td colspan="6" class="empty">Aún no ingresan estudiantes.</td></tr>'}</tbody></table></div>${detailHtml}<div class="card" style="margin-top:20px"><div class="subhead"><h2 class="section-title" style="margin:0">Registro de eventos del navegador</h2><span class="muted mini">Los eventos de pérdida de foco pueden tener causas inocuas.</span></div>${incidents||'<div class="muted mini">Aún no hay eventos registrados.</div>'}</div><div class="notice warning" style="margin-top:18px">Un cambio de pestaña es un indicador técnico, no una prueba de copia. Las desconexiones, restricciones del sistema operativo y funciones de accesibilidad pueden afectar los registros. La corrección automática no incluye las preguntas abiertas.</div>`;insertExamQR(ex);}
function csvCell(v){let s=String(v??'');if(/^[=+@\-]/.test(s))s="'"+s;return `"${s.replace(/"/g,'""')}"`;}
function downloadCsv(name,rows){const content='\ufeff'+rows.map(row=>row.map(csvCell).join(';')).join('\r\n');const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));const a=el('a',{href:url,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1200)}
function exportSummary(){const e=state.exam,s=state.snapshot;const rows=[['Estudiante','Curso','Número de lista','Correo electrónico','Situación','Puntaje selección','Puntaje máximo selección','Preguntas abiertas pendientes','Pestaña oculta (eventos)','Salida de pantalla completa (eventos)','Pérdidas de foco (eventos)','Ingreso','Entrega']];for(const st of s.students){const x=scoring(st,s,state.questions);rows.push([st.name,st.curso||'',st.numero_lista??'',st.email||'',statusStudent(st,e),x.auto,x.max,x.open,countEvents(st,s,'hidden'),countEvents(st,s,'fullscreen_exit'),countEvents(st,s,'blur'),fmt(st.joined_at),fmt(st.submitted_at)])}downloadCsv(`resumen_${e.code}.csv`,rows)}
function exportDetail(){const e=state.exam,s=state.snapshot;const rows=[['Estudiante','Curso','Número de lista','Correo electrónico','Pregunta','Tipo','Enunciado','Respuesta','Puntos máximos','Respuesta correcta (pauta)','Fecha guardado']];for(const st of s.students)for(let i=0;i<state.questions.length;i++){const q=state.questions[i],a=s.answers.find(a=>a.participant_id===st.id&&a.question_id===q.id);const readable=val=>val===undefined||val===null?'':q.kind==='short'?String(val):Array.isArray(val)?val.map(n=>q.options?.[Number(n)]||'').join(' / '):q.options?.[Number(val)]||'';rows.push([st.name,st.curso||'',st.numero_lista??'',st.email||'',i+1,q.kind,q.prompt,a?readable(a.response):'',q.points,q.kind==='short'?'Corrección manual':q.correct.map(n=>q.options?.[Number(n)]||'').join(' / '),a?fmt(a.saved_at):''])}downloadCsv(`respuestas_${e.code}.csv`,rows)}

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
function studentDone(){const key=studentPositionKey();if(key){try{localStorage.removeItem(key)}catch(e){}}setView('student-done');if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});app.innerHTML=`<div class="narrow"><div class="card" style="text-align:center;padding:50px 28px"><div class="choice-icon student" style="margin:0 auto 16px">✓</div><h1 style="font-size:27px">Entrega registrada</h1><p class="muted">${esc(studentLoad?.participant.name||'Estudiante')}, tu prueba ha sido enviada. El profesor podrá revisar tus respuestas y las incidencias registradas.</p><button class="btn btn-outline" data-action="home" style="margin-top:16px">Volver al inicio</button></div></div>`;}
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
function persistAnswer(qid,value){const previous=inFlight.get(qid)||Promise.resolve();const next=previous.catch(()=>{}).then(()=>studentSave(qid,value)).then(()=>{if($('#save-state')&&state.view==='student-exam')$('#save-state').textContent='Respuestas guardadas';}).catch(ex=>{if($('#save-state'))$('#save-state').textContent='Error al guardar: compruebe su conexión';throw ex});inFlight.set(qid,next);return next}
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
 if(a==='home'){viewHome();return}if(a==='teacher'){await teacherEntrance();return}if(a==='student'){studentEntrance();return}if(a==='teacher-list'){await teacherList();return}if(a==='new-exam'){await newExam();return}if(a==='open-exam'){await openExam(b.dataset.id);return}
 if(a==='add-question'){collectDraft();state.draft.push(draftQuestion());editor();return}if(a==='remove-question'){collectDraft();state.draft.splice(Number(b.dataset.i),1);editor();return}
 if(a==='save-draft'){b.disabled=true;await saveDraft(false);return}if(a==='publish'){b.disabled=true;await saveDraft(true);return}
 if(a==='import-script'){collectDraft();const qs=parseAppsScript($('#script-input').value);addImported(qs,'Google Apps Script');return}
 if(a==='duration-preset'){const field=$('#exam-duration');if(field){field.value=b.dataset.minutes;field.focus()}return}
  if(a==='download-qr'){downloadExamQR();toast('Código QR descargado');return}
  if(a==='copy-link'){const url=examJoinUrl(state.exam);await navigator.clipboard.writeText(url);toast('Enlace de ingreso copiado');return}
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
app.addEventListener('change',async e=>{if(e.target.id==='pdf-file'&&e.target.files?.[0]){const info=$('#pdf-info');try{info.textContent='Extrayendo texto del PDF…';const text=await pdfRead(e.target.files[0]);const questions=parseTextQuestions(text);info.textContent=`${questions.length} preguntas de selección detectadas.`;addImported(questions,'PDF')}catch(ex){info.textContent='No fue posible interpretar el PDF.';err(ex)}return}
 if(e.target.dataset.field==='kind'){const node=e.target.closest('.question-editor');node.querySelectorAll('.choice-config').forEach(x=>x.classList.toggle('hidden',e.target.value==='short'))}
 if(e.target.dataset.studentQ&&e.target.dataset.kind!=='short'){const qid=e.target.dataset.studentQ,kind=e.target.dataset.kind;let response=kind==='multi'?[...app.querySelectorAll(`[data-student-q="${qid}"]:checked`)].map(x=>Number(x.value)):Number(e.target.value);queueAnswer(qid,response)}});
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
window.addEventListener('pagehide',()=>{if(state.view!=='student-exam'||!state.activeStudent)return;
 if(isDemo){const d=db(),s=d.students.find(s=>s.exam_id===state.activeStudent.exam_id&&s.token===state.activeStudent.token);if(s){d.events.push({id:Date.now(),participant_id:s.id,kind:'pagehide',occurred_at:iso()});putDb(d)}return}
 // keepalive intenta entregar el evento incluso al navegar. No ofrece garantía de recepción.
 const endpoint=cfg.supabaseUrl.replace(/\/$/,'')+'/rest/v1/rpc/qx_student_event';const key=cfg.publishableKey;
 const headers={'content-type':'application/json',apikey:key};if(key.startsWith('eyJ'))headers.Authorization='Bearer '+key;
 try{fetch(endpoint,{method:'POST',keepalive:true,headers,body:JSON.stringify({p_exam:state.activeStudent.exam_id,p_token:state.activeStudent.token,p_kind:'pagehide'})}).catch(()=>{})}catch(e){}
});
window.addEventListener('storage',()=>{if(isDemo&&state.view==='dashboard')refreshDashboard().catch(console.error)});

async function init(){try{if(!isDemo){const {createClient}=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');supa=createClient(cfg.supabaseUrl,cfg.publishableKey);const {data:{user}}=await supa.auth.getUser();state.teacher=user||null;}else db();$('#mode-tag').textContent=isDemo?'Demostración local':'Conectado a Supabase';const params=new URLSearchParams(location.search);if(params.has('code'))studentEntrance();else if(params.get('docente')==='1')teacherEntrance();else studentEntrance();}catch(ex){console.error(ex);app.innerHTML=`<div class="card narrow"><h2>No se pudo iniciar la aplicación</h2><p class="muted">${esc(ex?.message||ex)}</p><p>Compruebe la configuración de Supabase y su conexión.</p></div>`}}
init();
