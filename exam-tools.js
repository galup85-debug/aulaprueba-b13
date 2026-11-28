/* v5.8: órdenes estables y fórmulas matemáticas seguras. */
export function optionOrder(q){
 const base=(q.options||[]).map((_,i)=>i),o=q.option_order;
 return Array.isArray(o)&&o.length===base.length&&new Set(o).size===base.length&&o.every(i=>Number.isInteger(i)&&i>=0&&i<base.length)?o:base;
}
// Modo demostración: estable por token. En producción se utiliza el RPC de Supabase.
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++){h=Math.imul(h^s.charCodeAt(i),16777619)}h^=h>>>16;h=Math.imul(h,0x85ebca6b);return (h^(h>>>13))>>>0}
function permutation(arr,key){const a=[...arr];let seed=hash(key)||1;for(let i=a.length-1;i>0;i--){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;const j=(seed>>>0)%(i+1);[a[i],a[j]]=[a[j],a[i]]}return a}
export function demoOrder(qs,exam,token){
 const mapped=qs.map(q=>({...q,option_order:exam.shuffle_options&&q.kind!=='short'?permutation((q.options||[]).map((_,i)=>i),token+':option:'+q.id):null}));
 return exam.shuffle_questions?permutation(mapped,token+':question'):mapped;
}
const escapeHTML=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mathHTML(value){
 const s=String(value??'');let result='',end=0;
 // Delimitadores explícitos, para no confundir precios o monedas con fórmulas.
 const re=/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g;
 for(const m of s.matchAll(re)){
  const tex=m[1]??m[2]??m[3],display=m[1]===undefined;
  result+=escapeHTML(s.slice(end,m.index));
  result+='<span class="math-source'+(display?' math-block':'')+'" data-tex="'+escapeHTML(tex)+'" data-display="'+(display?'1':'0')+'">'+escapeHTML(m[0])+'</span>';
  end=m.index+m[0].length;
 }
 return result+escapeHTML(s.slice(end));
}
let mathLoader;
function getMath(){
 if(globalThis.katex?.render)return Promise.resolve(globalThis.katex);
 if(!mathLoader)mathLoader=new Promise((resolve,reject)=>{
  const script=document.createElement('script');
  script.src='https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js';
  script.onload=()=>globalThis.katex?.render?resolve(globalThis.katex):reject(Error('Motor matemático no disponible'));
  script.onerror=()=>{script.remove();reject(Error('No se pudo cargar el motor matemático'))};
  document.head.appendChild(script);
 }).catch(e=>{mathLoader=null;throw e});
 return mathLoader;
}
export async function renderMathIn(root){
 const nodes=[...root.querySelectorAll('[data-tex]:not([data-math-ready])')];
 if(!nodes.length)return;
 try{
  const k=await getMath();
  for(const n of nodes){
   if(!n.isConnected||n.dataset.mathReady)continue;
   try{k.render(n.dataset.tex,n,{displayMode:n.dataset.display==='1',throwOnError:true,trust:false,maxSize:12,maxExpand:500,strict:'warn'});n.dataset.mathReady='true';}
   catch(e){n.title='Fórmula no válida: revisa su sintaxis';n.classList.add('math-invalid');n.dataset.mathReady='error';}
  }
 }catch(e){for(const n of nodes)if(n.isConnected)n.title='No se cargó el motor matemático; se conserva la fórmula original.'}
}
export const MATH_BUTTONS=[
 ['²','²'],['³','³'],['√','√'],['π','π'],['×','×'],['÷','÷'],['±','±'],['≤','≤'],['≥','≥'],['≠','≠'],['∞','∞'],['∑','∑'],
 ['Fracción','\\(\\frac{a}{b}\\)'],['Potencia','\\(x^{2}\\)'],['Raíz','\\(\\sqrt{x}\\)'],['Ecuación','\\(ax^2+bx+c=0\\)'],
 ['Integral','\\(\\int_a^b f(x)\\,dx\\)'],['Fórmula','\\(x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}\\)']
];
