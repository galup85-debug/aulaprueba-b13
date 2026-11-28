-- AulaPrueba B-13 v5.8. Ejecutar después de actualizacion_v57.sql.
begin;
alter table public.qx_exams add column if not exists shuffle_questions boolean not null default false;
alter table public.qx_exams add column if not exists shuffle_options boolean not null default false;

-- Mantener los índices originales de las alternativas y las preguntas.
-- La permutación es estable por intento, no cambia al recargar ni al reingresar.
-- Se reutiliza la validación del token y la proyección sin pauta del RPC existente.
create or replace function public.qx_student_load_v58(p_exam uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare payload jsonb; sq boolean; so boolean; qs jsonb;
begin
 payload:=public.qx_student_load(p_exam,p_token);
 if payload is null or jsonb_typeof(payload->'questions') is distinct from 'array' then
  raise exception 'No fue posible cargar la evaluación';
 end if;
 select shuffle_questions,shuffle_options into sq,so from public.qx_exams where id=p_exam;
 if not found then raise exception 'Evaluación no encontrada'; end if;
 -- Proyectar exclusivamente datos públicos de cada pregunta. La pauta no se devuelve.
 select coalesce(jsonb_agg(
  jsonb_build_object('id',q.item->'id','position',q.item->'position','kind',q.item->'kind',
   'prompt',q.item->'prompt','points',q.item->'points',
   'options',q.item->'options',
   'option_order',case when so and q.item->>'kind' in ('single','multi') then
    (select coalesce(jsonb_agg(o.idx-1 order by md5(p_token||':option:'||(q.item->>'id')||':'||o.idx::text),o.idx),'[]'::jsonb)
     from jsonb_array_elements(coalesce(q.item->'options','[]'::jsonb)) with ordinality o(val,idx))
    else null end)
  order by case when sq then md5(p_token||':question:'||(q.item->>'id')) else lpad(q.idx::text,10,'0') end,q.idx
 ),'[]'::jsonb) into qs
 from jsonb_array_elements(payload->'questions') with ordinality q(item,idx);
 return jsonb_set(payload,'{questions}',qs,true);
end $$;
revoke all on function public.qx_student_load_v58(uuid,text) from public,anon,authenticated;
grant execute on function public.qx_student_load_v58(uuid,text) to anon,authenticated;

-- Las copias mantienen las preferencias, sin alumnos ni resultados.
create or replace function public.qx_duplicate_exam(p_exam uuid,p_title text,p_code text)
returns uuid language plpgsql security definer set search_path='' as $$
declare src public.qx_exams%rowtype; dst uuid;
begin
 if auth.uid() is null then raise exception 'Acceso denegado'; end if;
 select * into src from public.qx_exams where id=p_exam and teacher_id=auth.uid() for share;
 if not found then raise exception 'Evaluación no encontrada o sin autorización'; end if;
 insert into public.qx_exams(teacher_id,title,description,code,duration_minutes,status,exigencia,resultado_inmediato,shuffle_questions,shuffle_options)
 values(auth.uid(),trim(p_title),src.description,upper(trim(p_code)),src.duration_minutes,'draft',src.exigencia,src.resultado_inmediato,src.shuffle_questions,src.shuffle_options)
 returning id into dst;
 insert into public.qx_questions(exam_id,position,kind,prompt,options,correct,points)
 select dst,position,kind,prompt,options,correct,points from public.qx_questions where exam_id=src.id order by position;
 if to_regclass('public.qx_pedagogy') is not null then
  execute 'insert into public.qx_pedagogy(exam_id,dimensions,specifications) select $1,dimensions,specifications from public.qx_pedagogy where exam_id=$2' using dst,src.id;
 end if;
 return dst;
end $$;
revoke all on function public.qx_duplicate_exam(uuid,text,text) from public,anon,authenticated;
grant execute on function public.qx_duplicate_exam(uuid,text,text) to authenticated;

commit;
notify pgrst,'reload schema';
