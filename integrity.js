export const INTEGRITY_FIELDS=[
 ['copy','Bloquear copia de preguntas y alternativas'],['paste','Bloquear pegado de respuestas'],['select','Restringir selección de texto'],['menu','Restringir menú contextual'],['hide','Ocultar preguntas al perder el foco'],['watermark','Mostrar marca de agua personalizada'],['session','Permitir una sola sesión activa por alumno'],['warn','Mostrar advertencias progresivas'],['notify','Notificar incidencias al profesor'],['duration','Registrar duración de los episodios de salida']
];
export function integrityOf(exam){return Object.fromEntries(INTEGRITY_FIELDS.map(([k])=>[k,exam?.integrity?.[k]!==false]))}
export const EVENT_LABELS={hidden:'Pestaña no visible',visible:'Visibilidad recuperada',blur:'Pérdida de foco',focus:'Foco recuperado',pagehide:'Salida o navegación',resume:'Reingreso a evaluación',fullscreen_exit:'Salida de pantalla completa',fullscreen_enter:'Pantalla completa restablecida',reload:'Recarga',offline:'Sin conexión',online:'Conexión recuperada',copy_blocked:'Copia restringida',cut_blocked:'Corte restringido',paste_blocked:'Pegado restringido',drag_blocked:'Arrastre restringido',menu_blocked:'Menú contextual restringido',print_blocked:'Impresión restringida',session_blocked:'Otra sesión activa'};
export const RESTRICTED=['copy_blocked','cut_blocked','paste_blocked','drag_blocked','menu_blocked','print_blocked','session_blocked'];
export const ALERT_KINDS=['hidden','blur','pagehide','fullscreen_exit',...RESTRICTED];
export function durationLabel(ms){if(ms==null||!Number.isFinite(ms))return 'No determinada';const s=Math.max(0,Math.round(ms/1000));return s>=3600?Math.floor(s/3600)+' h '+Math.floor(s%3600/60)+' min '+s%60+' s':s>=60?Math.floor(s/60)+' min '+s%60+' s':s+' s'}
export function episodesOf(events,submitted=false,now=Date.now()){
 const open=new Set(),episodes=[];let episode=null;
 const starts={blur:'focus',hidden:'visible',pagehide:'resume',fullscreen_exit:'fullscreen_enter'};
 const ends={focus:'blur',visible:'hidden',resume:'pagehide',fullscreen_enter:'fullscreen_exit'};
 const title=e=>e.kinds.includes('pagehide')?'Salida o navegación':e.kinds.includes('hidden')?'Pestaña no visible':e.kinds.includes('blur')?'Pérdida de foco':'Salida de pantalla completa';
 // Pantalla completa se asocia a un episodio de salida si coincide, pero
 // un cambio de pantalla completa por sí solo no prueba ausencia.
 for(const e of [...events].sort((a,b)=>Date.parse(a.occurred_at)-Date.parse(b.occurred_at)||Number(a.id||0)-Number(b.id||0))){
  const t=Date.parse(e.occurred_at);if(!Number.isFinite(t))continue;
  if(e.kind==='fullscreen_exit'){if(episode&&!episode.kinds.includes(e.kind))episode.kinds.push(e.kind);continue}
  if(e.kind==='fullscreen_enter')continue;
  if(starts[e.kind]){
   if(!episode)episode={start:t,end:null,kinds:[],duration:null,status:'open'};
   if(!episode.kinds.includes(e.kind))episode.kinds.push(e.kind);
   open.add(e.kind);
  }else if(ends[e.kind]){
   if(!episode)continue;
   if(e.kind==='resume'){// Nueva carga confirma que se volvió a la evaluación, no que se recuperó inmediatamente el foco.
    open.delete('pagehide');
   }else open.delete(ends[e.kind]);
   if(open.size===0){episode.end=t;episode.duration=Math.max(0,t-episode.start);episode.status='closed';episode.label=title(episode);episodes.push(episode);episode=null}
  }
 }
 if(episode){episode.status=submitted?'unknown':'open';episode.elapsed=submitted?null:Math.max(0,now-episode.start);episode.label=title(episode);episodes.push(episode)}
 return episodes;
}
