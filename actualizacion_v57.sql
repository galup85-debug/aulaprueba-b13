-- AulaPrueba B-13 v5.7. Instalar después de v5.0 y v5.6.
begin;
alter table public.qx_exams add column if not exists exigencia integer not null default 60 check (exigencia between 1 and 99);
alter table public.qx_exams add column if not exists resultado_inmediato boolean not null default true;

-- Resultado calculado exclusivamente en el servidor, con el token del intento ya entregado.
-- No devuelve alternativas correctas, respuestas de otros alumnos ni claves de corrección.
create or replace function public.qx_student_result(p_exam uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare st public.qx_participants; ex public.qx_exams; earned numeric; maximum numeric;
begin
 st:=qx_private.resolve_student(p_exam,p_token);
 select * into ex from public.qx_exams where id=p_exam;
 if st.submitted_at is null then return jsonb_build_object('available',false,'reason','not_submitted'); end if;
 if not ex.resultado_inmediato then return jsonb_build_object('available',false,'reason','disabled'); end if;
 if not exists(select 1 from public.qx_questions where exam_id=p_exam)
 or exists(select 1 from public.qx_questions where exam_id=p_exam and (kind not in ('single','multi') or jsonb_array_length(correct)=0))
 then return jsonb_build_object('available',false,'reason','manual'); end if;
 select coalesce(sum(case when q.kind='single' and a.response=q.correct->0 then q.points
  when q.kind='multi' and jsonb_typeof(a.response)='array' and a.response @> q.correct and q.correct @> a.response then q.points
  else 0::numeric end),0),coalesce(sum(q.points),0) into earned,maximum
 from public.qx_questions q left join public.qx_answers a on a.question_id=q.id and a.participant_id=st.id where q.exam_id=p_exam;
 -- No devolver resultados por pregunta ni por categoría, ni cantidad de aciertos.
 return jsonb_build_object('available',maximum>0,'earned',earned,'maximum',maximum,'exigencia',ex.exigencia);
end $$;
revoke all on function public.qx_student_result(uuid,text) from public,anon,authenticated;
grant execute on function public.qx_student_result(uuid,text) to anon,authenticated;

-- Duplicar también la exigencia y la preferencia de publicación inmediata.
create or replace function public.qx_duplicate_exam(p_exam uuid,p_title text,p_code text)
returns uuid language plpgsql security definer set search_path='' as $$
declare src public.qx_exams%rowtype; dst uuid;
begin
 if auth.uid() is null then raise exception 'Acceso denegado'; end if;
 select * into src from public.qx_exams where id=p_exam and teacher_id=auth.uid() for share;
 if not found then raise exception 'Evaluación no encontrada o sin autorización'; end if;
 insert into public.qx_exams(teacher_id,title,description,code,duration_minutes,status,exigencia,resultado_inmediato)
 values(auth.uid(),trim(p_title),src.description,upper(trim(p_code)),src.duration_minutes,'draft',src.exigencia,src.resultado_inmediato)
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
create or replace function public.qx_student_save(p_exam uuid,p_token text,p_question uuid,p_response jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare st public.qx_participants; ex public.qx_exams;
begin
 st:=qx_private.resolve_student(p_exam,p_token);
 select * into st from public.qx_participants where id=st.id for update;
 if not found then raise exception 'Sesión no reconocida'; end if;
 select * into ex from public.qx_exams where id=p_exam;
 if st.submitted_at is not null or ex.status<>'published' or clock_timestamp()>st.joined_at+make_interval(mins=>ex.duration_minutes)
 then raise exception 'La prueba está cerrada o el tiempo finalizó'; end if;
 if not exists(select 1 from public.qx_questions where id=p_question and exam_id=p_exam) then raise exception 'La pregunta no pertenece a esta prueba'; end if;
 if length(p_response::text)>30000 then raise exception 'Respuesta demasiado extensa'; end if;
 insert into public.qx_answers(participant_id,question_id,response) values(st.id,p_question,p_response)
 on conflict(participant_id,question_id) do update set response=excluded.response,saved_at=clock_timestamp();
 update public.qx_participants set last_seen_at=clock_timestamp() where id=st.id;
 return true;
end $$;
commit;
notify pgrst,'reload schema';
