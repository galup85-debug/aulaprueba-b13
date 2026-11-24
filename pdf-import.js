/* AulaPrueba v5.3: PDF digital y OCR local por página. */
let ocrLoader;
async function loadOCR(){
 if(globalThis.Tesseract?.createWorker)return globalThis.Tesseract;
 if(!ocrLoader)ocrLoader=new Promise((resolve,reject)=>{
  const script=document.createElement('script');
  script.src='https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
  script.onload=()=>globalThis.Tesseract?.createWorker?resolve(globalThis.Tesseract):reject(Error('No se pudo iniciar OCR.'));
  script.onerror=()=>{script.remove();reject(Error('No se pudo descargar el motor OCR. Revisa la conexión.'))};
  document.head.appendChild(script);
 }).catch(e=>{ocrLoader=null;throw e});
 return ocrLoader;
}
function pdfRows(items,table=false){
 const rows=new Map();
 for(const it of items){
  if(!it.str)continue;
  const y=Math.round(it.transform?.[5]||0),x=it.transform?.[4]||0;
  const row=rows.get(y)||[];row.push({x,s:it.str,w:Number(it.width)||0});rows.set(y,row);
 }
 return [...rows.entries()].sort((a,b)=>b[0]-a[0]).map(([,r])=>{
  r.sort((a,b)=>a.x-b.x);let out='',end=null;
  for(const it of r){out+=(end===null?'':table&&it.x-end>=9?'\t':' ')+it.s;end=Math.max(end??it.x,it.x+it.w)}
  return out.trim();
 }).join('\n');
}

// Agrupar marcadores de pregunta y alternativa con su texto por coordenadas.
// Los números dentro de recuadros pueden tener una línea de base distinta.
export function examRows(items){
 const entries=items.filter(it=>it.str?.trim()).map(it=>({s:it.str.trim(),x:Number(it.transform?.[4])||0,y:Number(it.transform?.[5])||0,w:Number(it.width)||0,h:Math.abs(Number(it.transform?.[3]))||10})).sort((a,b)=>b.y-a.y||a.x-b.x);
 const rows=[];
 for(const e of entries){const last=rows[rows.length-1];if(last&&Math.abs(last.y-e.y)<=Math.min(4.5,Math.max(2,e.h*.46)))last.parts.push(e);else rows.push({y:e.y,parts:[e]});}
 const out=[];let previous=null;
 for(const row of rows){const parts=row.parts.sort((a,b)=>a.x-b.x),first=parts[0],second=parts[1];let label='',contentX=first.x;
  const isolated=/^(\d{1,3}|[A-J])$/.test(first.s)&&second&&second.x-first.x-first.w>=6;
  if(isolated){label=first.s;contentX=second.x}
  const text=parts.slice(isolated?1:0).map(p=>p.s).join(' ').trim();
  if(!text)continue;
  const close=previous&&row.y<previous.y&&previous.y-row.y<=Math.max(16,1.55*first.h)&&Math.abs(contentX-previous.x)<=7;
  if(label){out.push(label+(/^\d+$/.test(label)?'. ':') ')+text)}
  else{if(!close)out.push('');out.push((close?'  ':'')+text)}
  previous={x:contentX,y:row.y};
 }
 return out.join('\n');
}
// En OCR, un marcador puede venir solo en una línea o separado por espacios.
function normalizeOCRRows(text){
 const lines=String(text||'').replace(/\r/g,'').split('\n'),out=[];
 for(let i=0;i<lines.length;i++){
  const line=lines[i].trim(),marker=line.match(/^(\d{1,3}|[A-J])$/);
  if(marker){let j=i+1;while(j<lines.length&&!lines[j].trim())j++;
   if(j<lines.length&&/^[\p{L}¿¡"'“(]/u.test(lines[j].trim())&&!/^(\d{1,3}|[A-J])$/.test(lines[j].trim())){out.push(marker[1]+(/^\d/.test(marker[1])?'. ':') ')+lines[j].trim());i=j;continue}}
  const separated=line.match(/^(\d{1,3}|[A-J])\s{2,}(\S.*)$/);
  if(separated){out.push(separated[1]+(/^\d/.test(separated[1])?'. ':') ')+separated[2]);continue}
  // OCR con un solo espacio: números únicamente si parecen ítems, letras en secuencia.
  const n=line.match(/^(\d{1,3})\s+(.+[?¿].*|[¿¡].*|(?:según|a partir|explica|justifica|identifica|describe|analiza|selecciona)\b.*)$/i);
  if(n){out.push(n[1]+'. '+n[2]);continue}
  out.push(lines[i]);
 }
 return out.join('\n');
}

export async function readPDF(file,{forceOCR=false,onProgress=()=>{}}={}){
 if(file.size>15*1024*1024)throw Error('PDF demasiado grande (máximo 15 MB).');
 const lib=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs');
 lib.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs';
 const pdf=await lib.getDocument({data:await file.arrayBuffer()}).promise;
 let worker=null,ocrPages=[],pages=[],tabular=[],current=0;
 try{
  if(pdf.numPages>100)throw Error('Máximo 100 páginas por PDF.');
  for(let i=1;i<=pdf.numPages;i++){
   current=i;onProgress('Página '+i+' de '+pdf.numPages+' · extrayendo texto');
   const page=await pdf.getPage(i);
   try{
    const content=await page.getTextContent(),raw=pdfRows(content.items),table=pdfRows(content.items,true);
    const letters=(raw.match(/\p{L}/gu)||[]).length;
    const broken=(raw.match(/\uFFFD/g)||[]).length;
    if(!forceOCR&&letters>=35&&broken<Math.max(3,letters*.03)){pages.push(examRows(content.items));tabular.push(table);continue}
    if(!worker){
     onProgress('Descargando motor OCR en español…');
     const t=await loadOCR();
     worker=await t.createWorker('spa',1,{logger:m=>{if(m.status==='recognizing text')onProgress('OCR página '+current+' de '+pdf.numPages+' · '+Math.round((m.progress||0)*100)+' %')}});
    }
    onProgress('OCR página '+i+' de '+pdf.numPages);
    const base=page.getViewport({scale:1}),scale=Math.min(2.7,2600/Math.max(base.width,base.height));
    const viewport=page.getViewport({scale}),canvas=document.createElement('canvas');
    canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    try{
     await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
     const result=await worker.recognize(canvas);
     const text=result.data.text||'';
     pages.push(normalizeOCRRows(text));tabular.push(text);ocrPages.push(i);
    }finally{canvas.width=0;canvas.height=0}
   }finally{page.cleanup()}
  }
  return {text:pages.join('\n\n'),table:tabular.join('\n\n'),ocrPages,pageCount:pdf.numPages};
 }finally{try{if(worker)await worker.terminate()}finally{await pdf.destroy()}}
}

/* v5.4: extraer ítems, no transcribir el documento completo. */
export function parsePDFExam(text){
 const lines=String(text||'').replace(/\r/g,'').split('\n');
 const questions=[],warnings=[],keyLines=[];
 let current=null,section='questions',lastOpt=-1,gap=false,discarded=0;
 const qre=/^(?:(?:pregunta|[íi]tem)\s*)?(\d{1,3})\s*[.)\-:]\s*(.+)$/i;
 const ore=/^\(?([A-J])\s*[.)\-:]\s*(.+)$/i;
 const ptsre=/\(\s*(\d+(?:[.,]\d+)?)\s*(?:puntos?|pts?\.?)\s*\)/i;
 const openCue=/^(?:explica|justifica|describe|analiza|argumenta|compara|fundamenta|interpreta|relaciona|identifica|menciona|escribe|redacta|responde|señala|determina|completa|calcula|desarrolla|evalúa|define|indica|enumera|propón|reflexiona|caracteriza|ejemplifica|formula)\b/i;
 const hasCue=s=>/[¿?]/.test(s)||openCue.test(s)||ptsre.test(s);
 const metadata=/^(?:(?:nombre(?:\s+y\s+apellido[s]?)?|curso|fecha|puntaje(?:\s+(?:ideal|total|obtenido|máximo))?|nota|profesor[a]?|docente|asignatura|objetivo(?:s)?(?:\s+de\s+aprendizaje)?|indicador(?:es)?|tiempo(?:\s+disponible)?|instrucciones(?:\s+generales)?)\s*[:._]|\s*(?:p[aá]gina|p[aá]g\.?)\s*\d+(?:\s*(?:de|\/)\s*\d+)?\s*$|^\d+\s*\/\s*\d+\s*$|^[_=–—-]{3,}$)/i;
 const boundary=/^(?:(?:texto|lectura|fragmento|documento|fuente|imagen|gr[aá]fico|tabla|secci[oó]n|parte|[íi]tem|eje)\s+(?:[IVX]+|\d+|[A-Z])(?:\s*[.:\-–—]|\s*$)|(?:lee|lea|lean|observa|observe|observan)\s+(?:atentamente\s+)?(?:el|la|los|las|este|esta|siguiente|atentamente)\b|(?:instrucciones(?:\s+generales)?|indicaciones|selecci[oó]n\s+(?:m[úu]ltiple|[úu]nica)|preguntas\s+de\s+desarrollo|comprensi[oó]n\s+lectora|verdadero\s+o\s+falso|fin\s+de\s+la\s+prueba|fin\s+de\s+la\s+evaluaci[oó]n)\s*[:.]?\s*$)/i;
 const isInstruction=s=>/^(?:marca|marque|marquen|encierra|encierre|selecciona|seleccione|lee|lea|responde|responda|escribe|escriba|utiliza|utilice|no\s+olvides)\b.*\b(?:alternativa\s+correcta|hoja\s+de\s+respuestas|l[aá]piz|siguientes\s+preguntas|cada\s+pregunta|toda\s+la\s+prueba|todas\s+las\s+preguntas)\b/i.test(s)&&!/[¿?]/.test(s);
 const isPageHeader=s=>/^(?:liceo|colegio|escuela|departamento|unidad\s+t[eé]cnico|ministerio)\b/i.test(s);
 const isHeading=s=>s.length>=4&&s.length<=100&&/[\p{L}]/u.test(s)&&s===s.toUpperCase()&&!/[¿?]/.test(s);
 const finish=()=>{
  if(!current)return;
  if(!current.options.length){
   if(!hasCue(current.prompt)||isInstruction(current.prompt)){discarded++;current=null;lastOpt=-1;return}
   current.kind='short';
   warnings.push('Pregunta '+current.sourceNumber+': sin alternativas reconocidas; confirma si es de desarrollo.');
  }else if(current.options.length<2)warnings.push('Pregunta '+current.sourceNumber+': solo una alternativa reconocida; completa o excluye el ítem.');
  if(current.options.length>10)warnings.push('Pregunta '+current.sourceNumber+': más de diez alternativas.');
  if(current.optionLetters.some((v,i)=>v!==String.fromCharCode(65+i)))warnings.push('Pregunta '+current.sourceNumber+': revisa las letras de las alternativas; se conserva su orden de aparición.');
  questions.push(current);current=null;lastOpt=-1;
 };
 for(const raw of lines){
  const line=raw.trim();
  if(!line){gap=true;continue}
  if(/^tabla\s+de\s+especificaciones(?:\s*[:.]|\s*$)/i.test(line)){finish();section='spec';continue}
  if(/^(?:pauta(?:\s+de\s+(?:correcci[oó]n|respuestas))?|clave\s+de\s+respuestas|respuestas\s+correctas|solucionario)\s*[:.]?\s*$/i.test(line)){finish();section='key';continue}
  if(section==='spec')continue;
  if(section==='key'){keyLines.push(line);continue}
  if(metadata.test(line)||isPageHeader(line)||/^\d{1,3}$/.test(line)){discarded++;continue}
  // Un encabezado temático o bloque de lectura cierra el ítem precedente.
  if(boundary.test(line)||isInstruction(line)||/^lee\s+y\s+responde\s+las\s+preguntas\b/i.test(line)){finish();discarded++;gap=false;continue}
  const q=line.match(qre);
  if(q){
   finish();
   const pts=q[2].match(ptsre);
   current={kind:'single',sourceNumber:Number(q[1]),prompt:q[2],options:[],correct:[],points:pts?Number(pts[1].replace(',','.')):1,optionLetters:[]};
   gap=false;continue;
  }
  const bareOption=current&&line.match(/^([A-J])\s+(.+)$/);const expected=current?String.fromCharCode(65+current.options.length):'';const option=line.match(ore)||(bareOption&&bareOption[1]===expected&&!/^A\s+partir\b/i.test(line)?bareOption:null);
  if(option&&current){
   const letter=option[1].toUpperCase();
   if(current.optionLetters.includes(letter))warnings.push('Pregunta '+current.sourceNumber+': alternativa '+letter+' repetida.');
   current.optionLetters.push(letter);current.options.push(option[2]);lastOpt=current.options.length-1;gap=false;continue;
  }
  if(!current){discarded++;continue}
  if(isHeading(line)&&!/^\s{2,}\S/.test(raw)){finish();discarded++;gap=false;continue}
  const prev=lastOpt>=0?current.options[lastOpt]:current.prompt;
  // Continuaciones prudentes. Una línea separada o un nuevo párrafo en
  // mayúscula después de una alternativa acabada no se agrega a la pregunta.
  const indented=/^\s{2,}\S/.test(raw);
  const continuation=!gap&&(indented||/^[\p{Ll},;:)]/u.test(line)||/[,;:(\-–—]$/.test(prev));
  if(lastOpt>=0){
   if(continuation){current.options[lastOpt]+=' '+line}
   else {warnings.push('Después de la pregunta '+current.sourceNumber+' se omitió texto sin etiqueta; revisa si era una continuación.');finish();discarded++}
  }else if(!gap&&(!/[?!]\s*$/.test(prev)||continuation)){
   current.prompt+=' '+line;
  }else{finish();discarded++}
  gap=false;
 }
 finish();
 const key=new Map(),ambiguous=new Set();
 for(const line of keyLines){
  const m=line.match(/^\s*(\d{1,3})\s*(?:[.)\-:;|]|\s)\s*([A-J](?:\s*[,/;+]\s*[A-J])*)\s*$/i);
  if(!m){warnings.push('Fila de pauta no reconocida: '+line.slice(0,100));continue}
  const n=Number(m[1]),letters=m[2].toUpperCase().match(/[A-J]/g);
  if(key.has(n)){ambiguous.add(n);warnings.push('Pauta duplicada para pregunta '+n+'.')}else key.set(n,letters);
 }
 const seen=new Set();
 for(const q of questions){
  const n=q.sourceNumber;
  if(seen.has(n))warnings.push('Número de pregunta repetido: '+n+'. Se conservó el orden de aparición.');
  seen.add(n);
  if(q.kind==='short'||!key.has(n)||ambiguous.has(n)||questions.filter(x=>x.sourceNumber===n).length!==1)continue;
  const indexes=key.get(n).map(x=>q.optionLetters.indexOf(x));
  if(indexes.some(i=>i<0)||new Set(q.optionLetters).size!==q.optionLetters.length){warnings.push('Pauta no vinculada a pregunta '+n+'.');continue}
  q.correct=[...new Set(indexes)];q.kind=q.correct.length>1?'multi':'single';
 }
 for(const n of key.keys())if(!questions.some(q=>q.sourceNumber===n))warnings.push('La pauta indica una pregunta '+n+' que no se reconoció.');
 return {questions:questions.map(({optionLetters,...q})=>q),warnings,discarded};
}
