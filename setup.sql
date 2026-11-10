-- Run in the existing DET Supabase SQL Editor as the project owner.
-- MAP uses separate tables. The existing teacher authorization stays in use.
begin;

create table if not exists public.map_g6_class (
  singleton boolean primary key default true check (singleton),
  class_code uuid not null default gen_random_uuid()
);
insert into public.map_g6_class (singleton) values (true) on conflict do nothing;

create table if not exists public.map_g6_papers (
  id text primary key,
  seq integer not null unique check (seq > 0),
  paper jsonb not null check (paper ->> 'id' = id and jsonb_typeof(paper -> 'questions') = 'array'),
  images jsonb not null default '{}'::jsonb
);

create table if not exists public.map_g6_attempts (
  id uuid primary key,
  token_hash bytea not null,
  paper_id text not null references public.map_g6_papers (id),
  student text not null check (student ~ '^[A-Z]{1,12}[0-9]{0,4}$'),
  question_ids text[] not null,
  answers jsonb not null default '{}'::jsonb,
  revision integer not null default 0,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  marks text[],
  grading jsonb not null default '{}'::jsonb,
  graded_at timestamptz
);
create index if not exists map_g6_attempts_recent on public.map_g6_attempts (updated_at desc, id);

alter table public.map_g6_class enable row level security;
alter table public.map_g6_papers enable row level security;
alter table public.map_g6_attempts enable row level security;
revoke all on public.map_g6_class, public.map_g6_papers, public.map_g6_attempts from public, anon, authenticated;
grant select on public.map_g6_class, public.map_g6_papers, public.map_g6_attempts to authenticated;
grant insert on public.map_g6_papers to authenticated;
grant update (grading, graded_at) on public.map_g6_attempts to authenticated;

drop policy if exists map_g6_teacher_read on public.map_g6_class;
create policy map_g6_teacher_read on public.map_g6_class for select to authenticated using ((select public.is_teacher()));
drop policy if exists map_g6_teacher_read on public.map_g6_papers;
create policy map_g6_teacher_read on public.map_g6_papers for select to authenticated using ((select public.is_teacher()));
drop policy if exists map_g6_teacher_import on public.map_g6_papers;
create policy map_g6_teacher_import on public.map_g6_papers for insert to authenticated with check ((select public.is_teacher()));
drop policy if exists map_g6_teacher_read on public.map_g6_attempts;
create policy map_g6_teacher_read on public.map_g6_attempts for select to authenticated using ((select public.is_teacher()));
drop policy if exists map_g6_teacher_grade on public.map_g6_attempts;
create policy map_g6_teacher_grade on public.map_g6_attempts for update to authenticated
  using ((select public.is_teacher()) and submitted_at is not null)
  with check ((select public.is_teacher()) and submitted_at is not null);

create or replace function public.map_g6_check_code(p_class_code uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.map_g6_class where class_code = p_class_code) then
    raise exception 'MAP_CLASS_CODE' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.map_g6_catalog(p_class_code uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public.map_g6_check_code(p_class_code);
  return coalesce((
    select jsonb_agg(
      (p.paper - array['questions', 'materials', 'instructions']) ||
      jsonb_build_object('questions', (
        select jsonb_agg(jsonb_build_object('id', q.value -> 'id', 'number', q.value -> 'number') order by q.pos)
        from jsonb_array_elements(p.paper -> 'questions') with ordinality as q(value, pos)
      )) order by p.seq
    ) from public.map_g6_papers p
  ), '[]'::jsonb);
end;
$$;

create or replace function public.map_g6_get_paper(p_class_code uuid, p_paper_id text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public.map_g6_check_code(p_class_code);
  return (
    select jsonb_build_object('images', p.images, 'paper',
      (p.paper - 'questions') || jsonb_build_object('questions', (
        select jsonb_agg(
          jsonb_build_object(
            'id', q.value -> 'id', 'number', q.value -> 'number', 'stem', q.value -> 'stem',
            'options', q.value -> 'options', 'materials', q.value -> 'materials', 'references', q.value -> 'references'
          ) order by q.pos
        ) from jsonb_array_elements(p.paper -> 'questions') with ordinality as q(value, pos)
      ))
    ) from public.map_g6_papers p where p.id = p_paper_id
  );
end;
$$;

create or replace function public.map_g6_save(
  p_class_code uuid, p_id uuid, p_token uuid, p_student text, p_paper_id text,
  p_question_ids text[], p_answers jsonb, p_revision integer, p_submit boolean
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  rec public.map_g6_attempts;
  bank jsonb;
  first_pos integer;
  expected_ids text[];
  graded text[];
  token_digest bytea := sha256(convert_to(p_token::text, 'UTF8'));
begin
  perform public.map_g6_check_code(p_class_code);
  if p_id is null or p_token is null or p_student is null or p_student !~ '^[A-Z]{1,12}[0-9]{0,4}$'
    or coalesce(cardinality(p_question_ids), 0) not between 1 and 100
    or p_answers is null or jsonb_typeof(p_answers) <> 'object' or pg_column_size(p_answers) > 25000
    or p_revision is null or p_revision < 1 or p_submit is null then
    raise exception 'MAP_INVALID_ATTEMPT';
  end if;

  select paper -> 'questions' into bank from public.map_g6_papers where id = p_paper_id;
  select q.pos into first_pos from jsonb_array_elements(bank) with ordinality as q(value, pos)
    where q.value ->> 'id' = p_question_ids[1];
  select array_agg(q.value ->> 'id' order by q.pos) into expected_ids
    from jsonb_array_elements(bank) with ordinality as q(value, pos)
    where q.pos >= first_pos and q.pos < first_pos + cardinality(p_question_ids);
  if expected_ids is distinct from p_question_ids or exists (
    select 1 from jsonb_each(p_answers) a
    where not exists (
      select 1 from jsonb_array_elements(bank) q, jsonb_array_elements(q -> 'options') o
      where q ->> 'id' = a.key and a.key = any(expected_ids) and o -> 0 = a.value
    )
  ) then
    raise exception 'MAP_INVALID_ANSWERS';
  end if;

  insert into public.map_g6_attempts (id, token_hash, paper_id, student, question_ids)
    values (p_id, token_digest, p_paper_id, p_student, p_question_ids)
    on conflict (id) do nothing;
  select * into rec from public.map_g6_attempts where id = p_id for update;
  if rec.token_hash <> token_digest or rec.student <> p_student
    or rec.paper_id <> p_paper_id or rec.question_ids <> p_question_ids then
    raise exception 'MAP_ATTEMPT_OWNER' using errcode = '42501';
  end if;

  if rec.revision >= p_revision or rec.submitted_at is not null then
    if rec.revision <> p_revision or rec.answers <> p_answers or (rec.submitted_at is not null) <> p_submit then
      raise exception 'MAP_ATTEMPT_CHANGED';
    end if;
  else
    if p_submit then
      select array_agg(case
        when jsonb_array_length(q.value -> 'key') = 0 then 'unscored'
        when not (p_answers ? (q.value ->> 'id')) then 'unanswered'
        when (q.value -> 'key') ? (p_answers ->> (q.value ->> 'id')) then 'correct'
        else 'incorrect'
      end order by q.pos) into graded
      from jsonb_array_elements(bank) with ordinality as q(value, pos)
      where q.pos >= first_pos and q.pos < first_pos + cardinality(p_question_ids);
    end if;
    update public.map_g6_attempts
      set answers = p_answers, revision = p_revision, updated_at = now(),
          submitted_at = case when p_submit then now() end, marks = graded
      where id = p_id returning * into rec;
  end if;
  return jsonb_build_object('revision', rec.revision, 'submitted_at', rec.submitted_at, 'marks', rec.marks);
end;
$$;

revoke all on function public.map_g6_check_code(uuid) from public, anon, authenticated;
revoke all on function public.map_g6_catalog(uuid) from public, anon, authenticated;
revoke all on function public.map_g6_get_paper(uuid, text) from public, anon, authenticated;
revoke all on function public.map_g6_save(uuid, uuid, uuid, text, text, text[], jsonb, integer, boolean) from public, anon, authenticated;
grant execute on function public.map_g6_catalog(uuid), public.map_g6_get_paper(uuid, text),
  public.map_g6_save(uuid, uuid, uuid, text, text, text[], jsonb, integer, boolean) to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') and not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'map_g6_attempts'
  ) then
    alter publication supabase_realtime add table public.map_g6_attempts;
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
