-- AulaPrueba B-13 v5.9: ejecutar después de v5.0, v5.7 y v5.8.
begin;
-- NULL distingue preguntas antiguas, cuyo modo se deduce en el editor.
alter table public.qx_questions add column if not exists editor_mode text
 check (editor_mode in ('textual','mathematical'));

create or replace function public.qx_replace_questions_v59(p_exam uuid,p_questions jsonb,p_dimensions jsonb,p_specs jsonb,p_modes jsonb)
returns int language plpgsql security definer set search_path='' as $$
declare n int; v jsonb;
begin
 if not exists(select 1 from public.qx_exams where id=p_exam and teacher_id=auth.uid() and status='draft' for update)
 then raise exception 'Solo el docente propietario puede editar un borrador'; end if;
 if jsonb_typeof(p_modes) is distinct from 'array' or jsonb_typeof(p_questions) is distinct from 'array'
 then raise exception 'Formato de modos de edición inválido'; end if;
 if jsonb_array_length(p_modes)<>jsonb_array_length(p_questions) then raise exception 'Modos y preguntas no coinciden'; end if;
 for v in select value from jsonb_array_elements(p_modes) loop
  if jsonb_typeof(v)<>'string' or v#>>'{}' not in ('textual','mathematical') then raise exception 'Modo de edición inválido'; end if;
 end loop;
 n:=public.qx_replace_questions_v5(p_exam,p_questions,p_dimensions,p_specs);
 with ordered as (select id,(row_number() over(order by position,id)-1)::int idx from public.qx_questions where exam_id=p_exam)
 update public.qx_questions q set editor_mode=p_modes->>o.idx from ordered o where q.id=o.id;
 return n;
end $$;
revoke all on function public.qx_replace_questions_v59(uuid,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.qx_replace_questions_v59(uuid,jsonb,jsonb,jsonb,jsonb) to authenticated;

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
 insert into public.qx_questions(exam_id,position,kind,prompt,options,correct,points,editor_mode)
 select dst,position,kind,prompt,options,correct,points,editor_mode from public.qx_questions where exam_id=src.id order by position;
 if to_regclass('public.qx_pedagogy') is not null then
  execute 'insert into public.qx_pedagogy(exam_id,dimensions,specifications) select $1,dimensions,specifications from public.qx_pedagogy where exam_id=$2' using dst,src.id;
 end if;
 return dst;
end $$;
revoke all on function public.qx_duplicate_exam(uuid,text,text) from public,anon,authenticated;
grant execute on function public.qx_duplicate_exam(uuid,text,text) to authenticated;

commit;
notify pgrst,'reload schema';
