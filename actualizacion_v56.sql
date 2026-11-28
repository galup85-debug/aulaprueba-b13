-- AulaPrueba B-13 v5.6. Ejecutar en el SQL Editor del proyecto existente.
-- Compatible con la migración v5.0; no modifica ni elimina registros existentes al instalar.
begin;
create or replace function public.qx_duplicate_exam(p_exam uuid,p_title text,p_code text)
returns uuid language plpgsql security definer set search_path='' as $$
declare src public.qx_exams%rowtype; dst uuid;
begin
 if auth.uid() is null then raise exception 'Acceso denegado'; end if;
 select * into src from public.qx_exams where id=p_exam and teacher_id=auth.uid() for share;
 if not found then raise exception 'Evaluación no encontrada o sin autorización'; end if;
 insert into public.qx_exams(teacher_id,title,description,code,duration_minutes,status)
 values(auth.uid(),trim(p_title),src.description,upper(trim(p_code)),src.duration_minutes,'draft')
 returning id into dst;
 insert into public.qx_questions(exam_id,position,kind,prompt,options,correct,points)
 select dst,position,kind,prompt,options,correct,points from public.qx_questions
 where exam_id=src.id order by position;
 -- La tabla pedagógica existe cuando está instalada la migración v5.0.
 if to_regclass('public.qx_pedagogy') is not null then
  execute 'insert into public.qx_pedagogy(exam_id,dimensions,specifications)
           select $1,dimensions,specifications from public.qx_pedagogy where exam_id=$2'
  using dst,src.id;
 end if;
 -- No se copian alumnos, tokens, respuestas, calificaciones, incidencias ni correos.
 return dst;
end $$;
revoke all on function public.qx_duplicate_exam(uuid,text,text) from public,anon,authenticated;
grant execute on function public.qx_duplicate_exam(uuid,text,text) to authenticated;

create or replace function public.qx_remove_participant(p_exam uuid,p_participant uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare removed uuid;
begin
 if auth.uid() is null then raise exception 'Acceso denegado'; end if;
 if not exists(select 1 from public.qx_exams e where e.id=p_exam and e.teacher_id=auth.uid())
 then raise exception 'Acceso denegado'; end if;
 perform pg_advisory_xact_lock(hashtext(p_exam::text));
 -- Las relaciones existentes ON DELETE CASCADE eliminan solo los datos de este intento.
 delete from public.qx_participants s using public.qx_exams e
 where s.id=p_participant and s.exam_id=p_exam and e.id=s.exam_id and e.teacher_id=auth.uid()
 returning s.id into removed;
 return removed is not null;
end $$;
revoke all on function public.qx_remove_participant(uuid,uuid) from public,anon,authenticated;
grant execute on function public.qx_remove_participant(uuid,uuid) to authenticated;
commit;
notify pgrst,'reload schema';
