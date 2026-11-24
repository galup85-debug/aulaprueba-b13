/* AulaPrueba B-13 v5 — análisis pedagógico, sin servicios externos. */
export const DEFAULT_DIMENSIONS=['Conocimiento','Habilidad','Eje temático'];
const clean=(v,max=160)=>typeof v==='string'?v.trim().slice(0,max):'';
export const dimensionsOf=v=>DEFAULT_DIMENSIONS.map((d,i)=>clean(v?.[i],80)||d);
export const tagsOf=v=>[0,1,2].map(i=>clean(v?.[i]));
export const norm=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
export function categoriesFrom(item,heading=''){
 const c=item?.categorias??item?.categories??item?.dimensiones;
 if(Array.isArray(c))return tagsOf(c);
 const o=c&&typeof c==='object'?c:item||{};
 return tagsOf([o.conocimiento??o.knowledge,o.habilidad??o.skill,o.ejeTematico??o.eje_tematico??o['eje temático']??o.eje??o.topic??heading]);
}
export function scoreItem(q,response,manual){
 if(q.kind==='short'){
  if(manual===null||manual===undefined||manual==='')return null;
  const n=Number(manual);return Number.isFinite(n)&&n>=0&&n<=Number(q.points)?n:null;
 }
 const expected=(q.correct||[]).map(Number).sort((a,b)=>a-b);
 if(!expected.length)return null;
 if(response===null||response===undefined)return 0;
 const got=q.kind==='multi'?(Array.isArray(response)?response.map(Number).sort((a,b)=>a-b):[]):[Number(response)];
 return JSON.stringify(got)===JSON.stringify(expected)?Number(q.points):0;
}
const pct=(a,b)=>b>0?100*a/b:null;
export function analyze(questions,students,answers,manual,dimensions=DEFAULT_DIMENSIONS,low=60,high=80){
 const submitted=students.filter(s=>s.submitted_at);
 const responseMap=new Map(answers.map(a=>[a.participant_id+'|'+a.question_id,a.response]));
 const scoreMap=new Map(manual.map(a=>[a.participant_id+'|'+a.question_id,a.points]));
 const dims=dimensionsOf(dimensions).map((name,i)=>({name,groups:new Map(),index:i}));
 const individual=[],items=questions.map((q,i)=>({q,number:i+1,earned:0,max:0,graded:0,pending:0,blank:0,counts:(q.options||[]).map(()=>0)}));
 let earned=0,max=0,pending=0,classified=0;
 for(const q of questions)if(tagsOf(q.categories).some(Boolean))classified++;
 for(const st of submitted){
  let se=0,sm=0,sp=0;
  const buckets=dims.map(()=>new Map());
  for(let i=0;i<questions.length;i++){
   const q=questions[i],item=items[i],key=st.id+'|'+q.id,r=responseMap.get(key);
   const blank=r===undefined||r===null||(Array.isArray(r)&&!r.length)||(typeof r==='string'&&!r.trim());
   if(blank)item.blank++;
   if(q.kind!=='short'){
    const selected=q.kind==='multi'?(Array.isArray(r)?r:[]):blank?[]:[r];
    for(const n of new Set(selected.map(Number)))if(Number.isInteger(n)&&n>=0&&n<item.counts.length)item.counts[n]++;
   }
   const score=scoreItem(q,r,scoreMap.get(key));
   if(score===null){item.pending++;sp++;pending++;continue;}
   const points=Number(q.points)||0;
   item.earned+=score;item.max+=points;item.graded++;se+=score;sm+=points;
   tagsOf(q.categories).forEach((v,k)=>{
    if(!v)return;
    for(const m of [dims[k].groups,buckets[k]]){
     const key=norm(v),g=m.get(key)||{name:v,earned:0,max:0,questions:new Set(),n:0};
     g.earned+=score;g.max+=points;g.questions.add(i+1);g.n++;m.set(key,g);
    }
   });
  }
  const groups=buckets.map((m,i)=>({name:dims[i].name,groups:[...m.values()].map(g=>({...g,questions:[...g.questions],pct:pct(g.earned,g.max)}))}));
  earned+=se;max+=sm;individual.push({student:st,earned:se,max:sm,pending:sp,pct:pct(se,sm),dimensions:groups});
 }
 const sorted=items.map(i=>({...i,pct:pct(i.earned,i.max)}));
 const groups=dims.map(d=>({name:d.name,groups:[...d.groups.values()].map(g=>({...g,questions:[...g.questions],pct:pct(g.earned,g.max)})).sort((a,b)=>(b.pct??-1)-(a.pct??-1))}));
 const complete=individual.filter(i=>i.pct!==null&&!i.pending);
 return {submitted:submitted.length,enrolled:students.length,questionCount:questions.length,classified,earned,max,pct:pct(earned,max),pending,individual,items:sorted,dimensions:groups,distribution:{high:complete.filter(i=>i.pct>=high).length,middle:complete.filter(i=>i.pct>=low&&i.pct<high).length,low:complete.filter(i=>i.pct<low).length,excluded:individual.length-complete.length},low,high};
}
export function feedback(report){
 if(!report.submitted)return {summary:'Todavía no hay evaluaciones entregadas.',strengths:[],needs:[],priority:[],recommendation:'Espera a que haya entregas para interpretar resultados.'};
 const usable=report.dimensions.flatMap(d=>d.groups.filter(g=>g.pct!==null).map(g=>({...g,dimension:d.name})));
 const strengths=usable.filter(g=>g.pct>=report.high).sort((a,b)=>b.pct-a.pct).slice(0,4);
 const needs=usable.filter(g=>g.pct<report.low).sort((a,b)=>a.pct-b.pct).slice(0,4);
 const priority=report.items.filter(i=>i.pct!==null&&i.pct<report.low).sort((a,b)=>a.pct-b.pct).slice(0,5);
 const fmt=n=>n===null?'sin puntaje calculable':n.toLocaleString('es-CL',{maximumFractionDigits:1})+' %';
 return {summary:'Se analizaron '+report.submitted+' de '+report.enrolled+' estudiantes inscritos. El logro sobre los puntos corregidos es '+fmt(report.pct)+'.'+(report.pending?' Resultado provisional: '+report.pending+' respuestas o pautas pendientes de corrección.':''),strengths,needs,priority,recommendation:priority.length?'Revisar las preguntas '+priority.map(i=>i.number).join(', ')+', contrastar alternativas y solicitar fundamentaciones. Volver a evaluar los aprendizajes después del reforzamiento.':'Revisar la distribución por pregunta y consolidar los aprendizajes. Los datos por sí solos no identifican las causas de los errores.'};
}
export function parseSpecificationTable(text,dimensionNames=DEFAULT_DIMENSIONS){
 const names=dimensionsOf(dimensionNames);
 const split=line=>line.includes('\t')?line.split('\t'):line.includes('|')?line.split('|'):line.includes(';')?line.split(';'):line.split(/ {2,}/);
 const out=[],warnings=[];let header=null,headerSeen=false;
 const aliases=[['conocimiento','contenido','knowledge'],['habilidad','skill'],['eje tematico','eje','tema','topic']];
 for(const [i,raw] of String(text??'').replace(/\r/g,'').split('\n').entries()){
  const line=raw.trim();if(!line)continue;
  let cells=split(line).map(x=>x.trim());
  if(line.startsWith('|'))cells.shift();if(line.endsWith('|'))cells.pop();
  const normalized=cells.map(norm);
  const first=normalized.findIndex(v=>/^(pregunta(s)?|item(s)?|numero|n[.°º]?|nro[.]?|n[.°º] de pregunta)$/.test(v));
  if(first!==-1){
   const indexes=names.map((name,k)=>normalized.findIndex(v=>v===norm(name)||aliases[k].includes(v)));
   if(indexes.some(k=>k>=0)){header={first,indexes};headerSeen=true;continue;}
  }
  if(cells.length<2)continue;
  const field=header?cells[header.first]:cells[0];
  if(!/^\d{1,3}$/.test(field??''))continue;
  const number=Number(field);
  if(number<1||number>100){warnings.push('Fila '+(i+1)+': número fuera de rango');continue;}
  const tags=header?tagsOf(header.indexes.map(k=>k<0?'':cells[k])):tagsOf(cells.slice(1,4));
  if(!tags.some(Boolean)){warnings.push('Pregunta '+number+': sin categorías reconocibles');continue;}
  if(out.some(r=>r.number===number)){warnings.push('Pregunta '+number+': fila duplicada, se conservó la primera');continue;}
  out.push({number,tags});
 }
 if(!headerSeen&&out.length)warnings.push('Se asumió orden de columnas: pregunta, '+names.join(', ')+'.');
 return {rows:out,warnings};
}

/* v5.2: exportación reproducible, sin ejecutar código ni publicar formularios. */
export function generateGoogleScript(exam,questions,dimensions){
 if(!questions.length)throw Error('Añade preguntas antes de generar el script.');
 const dims=dimensionsOf(dimensions);
 const rows=questions.map((q,i)=>{
  const kind=['single','multi','short'].includes(q.kind)?q.kind:'single';
  const prompt=String(q.prompt??'').trim(),points=Number(q.points);
  const options=kind==='short'?[]:(q.options||[]).map(v=>String(v).trim());
  const correct=kind==='short'?[]:[...new Set((q.correct||[]).map(Number))];
  if(!prompt)throw Error('Falta el enunciado de la pregunta '+(i+1));
  if(!Number.isInteger(points)||points<0||points>100)throw Error('Google Forms requiere puntajes enteros. Revisa la pregunta '+(i+1));
  if(kind!=='short'&&(options.length<2||options.length>10||options.some(x=>!x)||new Set(options).size!==options.length||!correct.length||correct.some(n=>!Number.isInteger(n)||n<0||n>=options.length)||(kind==='single'&&correct.length!==1)))throw Error('Revisa alternativas y pauta de la pregunta '+(i+1));
  return {numero:i+1,tipo:kind,enunciado:prompt,opciones:options,correcta:correct,puntos:points,categorias:tagsOf(q.categories)};
 });
 const literal=v=>JSON.stringify(v,null,2).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 const specs=rows.map(q=>({pregunta:q.numero,categorias:q.categorias}));
 return [
 '// Generado por AulaPrueba B-13 v5.2.',
 '// Ejecuta crearEvaluacion() una sola vez en script.google.com.',
 '// Crea un formulario y una hoja de especificaciones separada; las categorías no se muestran al alumno.',
 '// Google Forms no reproduce el temporizador ni la supervisión de AulaPrueba.',
 'const tituloEvaluacion = '+literal(String(exam.title||'Evaluación'))+';',
 'const instruccionesEvaluacion = '+literal(String(exam.description||''))+';',
 'const dimensionesEvaluacion = '+literal(dims)+';',
 'const preguntas = '+literal(rows)+';',
 'const tablaEspecificaciones = '+literal(specs)+';',
 '',
 'function crearEvaluacion() {',
 '  const form = FormApp.create(tituloEvaluacion);',
 '  form.setIsQuiz(true);',
 '  form.setDescription(instruccionesEvaluacion);',
 '  form.setShuffleQuestions(false);',
 '  form.addTextItem().setTitle("Nombre y apellido").setRequired(true);',
 '  form.addTextItem().setTitle("Curso").setRequired(true);',
 '  form.addTextItem().setTitle("Número de lista").setRequired(true);',
 '  form.addTextItem().setTitle("Correo electrónico").setRequired(true);',
 '  preguntas.forEach(function(q) {',
 '    let item;',
 '    if (q.tipo === "short") {',
 '      item = form.addParagraphTextItem();',
 '    } else {',
 '      item = q.tipo === "multi" ? form.addCheckboxItem() : form.addMultipleChoiceItem();',
 '      item.setChoices(q.opciones.map(function(op, i) { return item.createChoice(op, q.correcta.indexOf(i) !== -1); }));',
 '    }',
 '    item.setTitle(q.numero + ". " + q.enunciado).setPoints(q.puntos).setRequired(false);',
 '  });',
 '  const libro = SpreadsheetApp.create("Especificaciones - " + tituloEvaluacion);',
 '  const hoja = libro.getSheets()[0];',
 '  hoja.setName("Tabla de especificaciones");',
 '  const seguro = function(v) { return typeof v === "string" && /^[=+@-]/.test(v) ? "\\x27" + v : v; };',
 '  const filas = [["Pregunta"].concat(dimensionesEvaluacion).concat(["Puntaje"])];',
 '  tablaEspecificaciones.forEach(function(r,i) { filas.push([r.pregunta].concat(r.categorias).concat([preguntas[i].puntos])); });',
 '  hoja.getRange(1, 1, filas.length, 5).setValues(filas.map(r => r.map(seguro)));',
 '  hoja.setFrozenRows(1);',
 '  hoja.getRange(1, 1, 1, 5).setFontWeight("bold");',
 '  hoja.autoResizeColumns(1,5);',
 '  Logger.log("Editar formulario: " + form.getEditUrl());',
 '  Logger.log("Enlace estudiantes: " + form.getPublishedUrl());',
 '  Logger.log("Tabla de especificaciones: " + libro.getUrl());',
 '}',''].join('\n');
}
