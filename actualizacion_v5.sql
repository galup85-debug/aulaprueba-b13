-- AulaPrueba B-13 v5.0: ampliación no destructiva. Ejecutar en SQL Editor.
begin;
create table if not exists public.qx_pedagogy (
 exam_id uuid primary key references public.qx_exams(id) on delete cascade,
 dimensions jsonb not null default '["Conocimiento","Habilidad","Eje temático"]'::jsonb,
 specifications jsonb not null default '[]'::jsonb,
 check (jsonb_typeof(dimensions)='array' and jsonb_array_length(dimensions)=3),
 check (jsonb_typeof(specifications)='array' and jsonb_array_length(specifications)<=100)
);
alter table public.qx_pedagogy enable row level security;
revoke all on public.qx_pedagogy from public,anon,authenticated;
grant select on public.qx_pedagogy to authenticated;
drop policy if exists qx_pedagogy_read on public.qx_pedagogy;
create policy qx_pedagogy_read on public.qx_pedagogy for select to authenticated
 using (exists(select 1 from public.qx_exams e where e.id=exam_id and e.teacher_id=(select auth.uid())));

-- Wrapper atómico: si falla la tabla de especificaciones, tampoco cambian las preguntas.
create or replace function public.qx_replace_questions_v5(p_exam uuid,p_questions jsonb,p_dimensions jsonb,p_specs jsonb)
returns int language plpgsql security definer set search_path='' as $$
declare n int; v_row jsonb; v_val jsonb;
begin
 if not exists(select 1 from public.qx_exams e where e.id=p_exam and e.teacher_id=auth.uid() and e.status='draft')
 then raise exception 'Solo el docente propietario puede editar un borrador'; end if;
 if jsonb_typeof(p_dimensions) is distinct from 'array' or jsonb_array_length(p_dimensions)<>3
 then raise exception 'Se requieren tres nombres de dimensiones'; end if;
 for v_val in select value from jsonb_array_elements(p_dimensions) loop
  if jsonb_typeof(v_val)<>'string' or length(v_val#>>'{}') not between 1 and 80 then raise exception 'Nombre de dimensión inválido'; end if;
 end loop;
 if jsonb_typeof(p_questions) is distinct from 'array' or jsonb_typeof(p_specs) is distinct from 'array'
 then raise exception 'Formato de preguntas o especificaciones inválido'; end if;
 if jsonb_array_length(p_specs)<>jsonb_array_length(p_questions) then raise exception 'La tabla debe corresponder a las preguntas'; end if;
 for v_row in select value from jsonb_array_elements(p_specs) loop
  if jsonb_typeof(v_row)<>'array' or jsonb_array_length(v_row)<>3 then raise exception 'Cada pregunta admite tres categorías'; end if;
  for v_val in select value from jsonb_array_elements(v_row) loop
   if jsonb_typeof(v_val)<>'string' or length(v_val#>>'{}')>160 then raise exception 'Categoría inválida'; end if;
  end loop;
 end loop;
 n:=public.qx_replace_questions(p_exam,p_questions);
 insert into public.qx_pedagogy(exam_id,dimensions,specifications)
 values(p_exam,p_dimensions,p_specs)
 on conflict(exam_id) do update set dimensions=excluded.dimensions,specifications=excluded.specifications;
 return n;
end $$;
revoke all on function public.qx_replace_questions_v5(uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.qx_replace_questions_v5(uuid,jsonb,jsonb,jsonb) to authenticated;

create table if not exists public.qx_manual_scores (
 participant_id uuid not null references public.qx_participants(id) on delete cascade,
 question_id uuid not null references public.qx_questions(id) on delete cascade,
 points numeric(8,2) not null check(points>=0 and points<=100),
 primary key(participant_id,question_id)
);
alter table public.qx_manual_scores enable row level security;
revoke all on public.qx_manual_scores from public,anon,authenticated;
grant select,insert,update,delete on public.qx_manual_scores to authenticated;
drop policy if exists qx_manual_owner on public.qx_manual_scores;
create policy qx_manual_owner on public.qx_manual_scores for all to authenticated
 using (exists(select 1 from public.qx_participants s join public.qx_questions q on q.exam_id=s.exam_id
 join public.qx_exams e on e.id=s.exam_id
 where s.id=participant_id and q.id=question_id and q.kind='short' and s.submitted_at is not null and e.teacher_id=(select auth.uid())))
 with check (exists(select 1 from public.qx_participants s join public.qx_questions q on q.exam_id=s.exam_id
 join public.qx_exams e on e.id=s.exam_id
 where s.id=participant_id and q.id=question_id and q.kind='short' and s.submitted_at is not null and e.teacher_id=(select auth.uid()) and qx_manual_scores.points<=q.points));
commit;
notify pgrst,'reload schema';
