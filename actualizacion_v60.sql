-- AulaPrueba B-13 v6.0. Ejecutar después de v5.9, fuera de evaluaciones en curso.
begin;
alter table public.qx_exams add column if not exists integrity jsonb not null default '{"copy":true,"paste":true,"select":true,"menu":true,"hide":true,"watermark":true,"session":true,"warn":true,"notify":true,"duration":true}'::jsonb check(jsonb_typeof(integrity)='object');
alter table public.qx_events drop constraint if exists qx_events_kind_check;
alter table public.qx_events add constraint qx_events_kind_check check(kind in ('hidden','visible','blur','focus','offline','online','pagehide','reload','fullscreen_exit','fullscreen_enter','copy_blocked','paste_blocked','cut_blocked','drag_blocked','menu_blocked','print_blocked','session_blocked','resume'));
-- Tabla privada: no expone identificadores de sesión en las consultas docentes.
create table if not exists qx_private.session_lease (
 participant_id uuid primary key references public.qx_participants(id) on delete cascade,
 client_id uuid not null, expires_at timestamptz not null
);
revoke all on qx_private.session_lease from public,anon,authenticated;
create or replace function qx_private.claim_v60(p_exam uuid,p_token text,p_client uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare st public.qx_participants; settings jsonb; acquired uuid;
begin
 st:=qx_private.resolve_student(p_exam,p_token);
 if st.submitted_at is not null then return true; end if;
 select integrity into settings from public.qx_exams where id=p_exam;
 if settings->'session'='false'::jsonb then return true; end if;
 if p_client is null then raise exception 'Identificador de sesión obligatorio'; end if;
 insert into qx_private.session_lease(participant_id,client_id,expires_at)
 values(st.id,p_client,clock_timestamp()+interval '60 seconds')
 on conflict(participant_id) do update set client_id=excluded.client_id,expires_at=excluded.expires_at
 where session_lease.client_id=excluded.client_id or session_lease.expires_at<=clock_timestamp()
 returning client_id into acquired;
 return acquired is not null;
end $$;
revoke all on function qx_private.claim_v60(uuid,text,uuid) from public,anon,authenticated;

create or replace function public.qx_student_load_v60(p_exam uuid,p_token text,p_client uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare payload jsonb; settings jsonb;
begin
 if not qx_private.claim_v60(p_exam,p_token,p_client) then return jsonb_build_object('session_conflict',true); end if;
 payload:=public.qx_student_load_v58(p_exam,p_token);
 select integrity into settings from public.qx_exams where id=p_exam;
 return jsonb_set(payload,'{exam,integrity}',settings,true);
end $$;
create or replace function public.qx_student_save_v60(p_exam uuid,p_token text,p_client uuid,p_question uuid,p_response jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if not qx_private.claim_v60(p_exam,p_token,p_client) then raise exception 'Otra sesión activa. Vuelve al navegador original.'; end if;
 return public.qx_student_save(p_exam,p_token,p_question,p_response);
end $$;
create or replace function public.qx_student_ping_v60(p_exam uuid,p_token text,p_client uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if not qx_private.claim_v60(p_exam,p_token,p_client) then raise exception 'Otra sesión activa. Vuelve al navegador original.'; end if;
 return public.qx_student_ping(p_exam,p_token);
end $$;
create or replace function public.qx_student_submit_v60(p_exam uuid,p_token text,p_client uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare st public.qx_participants;
begin
 if not qx_private.claim_v60(p_exam,p_token,p_client) then raise exception 'Otra sesión activa. Vuelve al navegador original.'; end if;
 st:=qx_private.resolve_student(p_exam,p_token);
 perform public.qx_student_submit(p_exam,p_token);
 delete from qx_private.session_lease where participant_id=st.id and client_id=p_client;
 return true;
end $$;
create or replace function public.qx_student_event_v60(p_exam uuid,p_token text,p_client uuid,p_kind text)
returns boolean language plpgsql security definer set search_path='' as $$
declare st public.qx_participants;
begin
 if p_kind not in ('hidden','visible','blur','focus','offline','online','pagehide','reload','fullscreen_exit','fullscreen_enter','copy_blocked','paste_blocked','cut_blocked','drag_blocked','menu_blocked','print_blocked','session_blocked','resume') then raise exception 'Evento no reconocido'; end if;
 if not qx_private.claim_v60(p_exam,p_token,p_client) then return false; end if;
 st:=qx_private.resolve_student(p_exam,p_token);
 if st.submitted_at is not null then return false; end if;
 insert into public.qx_events(participant_id,kind) values(st.id,p_kind);
 update public.qx_participants set last_seen_at=clock_timestamp() where id=st.id;
 -- Salida explícita: liberar el intento tras registrar el evento.
 if p_kind='pagehide' then delete from qx_private.session_lease where participant_id=st.id and client_id=p_client; end if;
 return true;
end $$;
revoke all on function public.qx_student_load_v60(uuid,text,uuid),public.qx_student_save_v60(uuid,text,uuid,uuid,jsonb),public.qx_student_ping_v60(uuid,text,uuid),public.qx_student_submit_v60(uuid,text,uuid),public.qx_student_event_v60(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.qx_student_load_v60(uuid,text,uuid),public.qx_student_save_v60(uuid,text,uuid,uuid,jsonb),public.qx_student_ping_v60(uuid,text,uuid),public.qx_student_submit_v60(uuid,text,uuid),public.qx_student_event_v60(uuid,text,uuid,text) to anon,authenticated;
-- Obligar a los clientes a utilizar la nueva ruta de sesión.
revoke execute on function public.qx_student_load(uuid,text),public.qx_student_load_v58(uuid,text),public.qx_student_save(uuid,text,uuid,jsonb),public.qx_student_ping(uuid,text),public.qx_student_submit(uuid,text),public.qx_student_event(uuid,text,text) from public,anon,authenticated;

create or replace function public.qx_duplicate_exam(p_exam uuid,p_title text,p_code text)
returns uuid language plpgsql security definer set search_path='' as $$
declare src public.qx_exams%rowtype; dst uuid;
begin
 if auth.uid() is null then raise exception 'Acceso denegado'; end if;
 select * into src from public.qx_exams where id=p_exam and teacher_id=auth.uid() for share;
 if not found then raise exception 'Evaluación no encontrada o sin autorización'; end if;
 insert into public.qx_exams(teacher_id,title,description,code,duration_minutes,status,exigencia,resultado_inmediato,shuffle_questions,shuffle_options,integrity)
 values(auth.uid(),trim(p_title),src.description,upper(trim(p_code)),src.duration_minutes,'draft',src.exigencia,src.resultado_inmediato,src.shuffle_questions,src.shuffle_options,src.integrity)
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
