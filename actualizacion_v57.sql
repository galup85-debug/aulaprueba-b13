-- AulaPrueba B-13 v5.7. Instalar después de v5.0 y v5.6.
begin;
alter table public.qx_exams add column if not exists exigencia integer not null default 60 check (exigencia between 1 and 99);
alter table public.qx_exams add column if not exists resultado_inmediato boolean not null default true;

-- Resultado calculado exclusivamente en el servidor, con el token del intento ya entregado.
-- No devuelve alternativas correctas, respuestas de otros alumnos ni claves de corrección.
create or replace function public.qx_student_result(p_exam uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare st public.qx_participants; ex public.qx_exams; dims jsonb:='["Conocimiento","Habilidad","Eje temático"]'; specs jsonb:='[]'; result jsonb;
begin
 st:=qx_private.resolve_student(p_exam,p_token);
 select * into ex from public.qx_exams where id=p_exam;
 if st.submitted_at is null then return jsonb_build_object('available',false,'reason','not_submitted'); end if;
 if not ex.resultado_inmediato then return jsonb_build_object('available',false,'reason','disabled'); end if;
 if not exists(select 1 from public.qx_questions where exam_id=p_exam)
 or exists(select 1 from public.qx_questions where exam_id=p_exam and (kind not in ('single','multi') or jsonb_array_length(correct)=0))
 then return jsonb_build_object('available',false,'reason','manual'); end if;
 if to_regclass('public.qx_pedagogy') is not null then
  execute 'select dimensions,specifications from public.qx_pedagogy where exam_id=$1' into dims,specs using p_exam;
 end if;
 dims:=coalesce(dims,'["Conocimiento","Habilidad","Eje temático"]'::jsonb);
 specs:=coalesce(specs,'[]'::jsonb);
 with scored as (
  select q.position,q.points,
   case when q.kind='single' and a.response=q.correct->0 then q.points
    when q.kind='multi' and jsonb_typeof(a.response)='array' and a.response @> q.correct and q.correct @> a.response then q.points
    else 0::numeric end earned,
   a.response is not null and a.response<>'null'::jsonb and a.response<>'[]'::jsonb answered,
   specs->(row_number() over(order by q.position)::int-1) tags
  from public.qx_questions q left join public.qx_answers a on a.question_id=q.id and a.participant_id=st.id
  where q.exam_id=p_exam
 ), totals as (select sum(earned) earned,sum(points) maximum,count(*) total,count(*) filter(where answered) answered from scored),
 groups as (
  select d.i dimension,trim(s.tags->>d.i) category,sum(s.earned) earned,sum(s.points) maximum,count(*) items
  from scored s cross join generate_series(0,2) d(i)
  where coalesce(trim(s.tags->>d.i),'')<>'' group by d.i,trim(s.tags->>d.i)
 )
 select jsonb_build_object('available',t.maximum>0,'reason',case when t.maximum<=0 then 'zero' else null end,'earned',t.earned,'maximum',t.maximum,'total',t.total,'answered',t.answered,'exigencia',ex.exigencia,
 'dimensions',dims,'groups',coalesce((select jsonb_agg(jsonb_build_object('dimension',g.dimension,'category',g.category,'earned',g.earned,'maximum',g.maximum,'items',g.items) order by g.dimension,g.category) from groups g),'[]'::jsonb)) into result from totals t;
 return result;
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
commit;
notify pgrst,'reload schema';
