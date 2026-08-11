-- Dept-Flow — the exam permit
--
-- The document a student carries into the hall. It is the end of every path in
-- this system: dues cleared, attendance counted, the list authorized.
--
-- IT READS THE AUTHORIZED LIST, NEVER LIVE ATTENDANCE
--
-- This is the whole design. A permit computed from current attendance could
-- disagree with the list the exam board sat with — a student who clears their
-- dues the week after authorization would print a permit saying they may sit a
-- paper the department's own record says they may not. The system would have
-- forged it itself.
--
-- So a course appears on a permit only when its eligibility list is
-- `authorized` and the snapshot inside it marks the student eligible. Before
-- the HOD authorizes, there is no permit — not an empty one, and not a
-- provisional one. The department has not decided yet, and saying otherwise on
-- a printed document is worse than saying nothing.

create table exam_permits (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references students (id) on delete cascade,
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  -- Printed on the document and typed into the public check page by whoever is
  -- holding it. Unguessable, because holding the reference is what stands in
  -- for holding the permit.
  reference           text not null unique,
  issued_at           timestamptz not null default now(),

  unique (student_id, academic_session_id),
  constraint permit_reference_format check (reference ~ '^DF-[0-9]{4}-[A-Z0-9]{6}$')
);

create index exam_permits_student_idx on exam_permits (student_id);

alter table exam_permits enable row level security;

-- A student reads their own; governance reads all. Nobody writes through the
-- policy — issuing goes through the function below.
create policy exam_permits_self_read on exam_permits
  for select to authenticated
  using (student_id = auth.uid());

create policy exam_permits_governance_read on exam_permits
  for select to authenticated
  using (is_hod() or is_admin());

-- ---------------------------------------------------------------------------
-- Issuing
-- ---------------------------------------------------------------------------

-- Idempotent: a student who downloads the permit three times gets one
-- reference, because the reference is the identity of the permit rather than
-- of the download. Re-issuing a new one each time would make every previously
-- printed copy unverifiable.
create or replace function issue_exam_permit(
  p_student_id          uuid,
  p_academic_session_id uuid
)
returns text
language plpgsql
as $$
declare
  v_reference text;
  v_eligible  integer;
  v_year      text;
begin
  select reference into v_reference
  from exam_permits
  where student_id = p_student_id and academic_session_id = p_academic_session_id;

  if v_reference is not null then
    return v_reference;
  end if;

  -- No authorized list marking them eligible for anything means no permit.
  select count(*) into v_eligible
  from eligibility_entries ee
  join eligibility_lists el on el.id = ee.list_id
  where ee.student_id = p_student_id
    and el.academic_session_id = p_academic_session_id
    and el.status = 'authorized'
    and ee.eligible;

  if v_eligible = 0 then
    return null;
  end if;

  select left(regexp_replace(name, '[^0-9]', '', 'g'), 4)
    into v_year
  from academic_sessions where id = p_academic_session_id;

  -- Retried rather than trusted: six characters from a 32-symbol alphabet is
  -- ample, but a collision must fail the download rather than hand two
  -- students one reference.
  for i in 1..10 loop
    v_reference := 'DF-' || coalesce(nullif(v_year, ''), '0000') || '-' ||
      upper(
        translate(
          substr(encode(gen_random_bytes(8), 'base64'), 1, 6),
          -- Removing the characters a person copying by hand confuses.
          '+/OIL01', 'XYZWVUT'
        )
      );

    begin
      insert into exam_permits (student_id, academic_session_id, reference)
      values (p_student_id, p_academic_session_id, v_reference);
      return v_reference;
    exception when unique_violation then
      -- Another download of the same permit won the race: return theirs.
      select reference into v_reference
      from exam_permits
      where student_id = p_student_id and academic_session_id = p_academic_session_id;
      if v_reference is not null then return v_reference; end if;
    end;
  end loop;

  raise exception 'could not allocate a permit reference';
end;
$$;

comment on function issue_exam_permit(uuid, uuid) is
  'One reference per student per session, allocated once. Returns null when no authorized list marks them eligible for anything.';

-- ---------------------------------------------------------------------------
-- Verifying
-- ---------------------------------------------------------------------------

-- For whoever is holding the paper — an invigilator at the hall door. Returns
-- the least that answers "is this real and what does it entitle them to":
-- the name, the matric number, and the papers. No attendance percentages, no
-- dues history, no phone number. A permit check is not a records request.
create or replace function verify_exam_permit(p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_permit exam_permits%rowtype;
  v_result jsonb;
begin
  select * into v_permit from exam_permits where reference = upper(btrim(p_reference));

  if v_permit.id is null then
    return jsonb_build_object('found', false);
  end if;

  select jsonb_build_object(
    'found', true,
    'reference', v_permit.reference,
    'issued_at', v_permit.issued_at,
    'matric_no', s.matric_no,
    'name', display_name_register(p.surname, p.first_name, p.other_names),
    'level', s.level,
    'session', a.name,
    -- Deactivated after the permit was issued: the document is genuine and the
    -- account is not. An invigilator needs to be told, rather than shown a
    -- valid-looking permit.
    'account_active', s.status <> 'deactivated',
    'courses', coalesce((
      select jsonb_agg(c.code order by c.code)
      from eligibility_entries ee
      join eligibility_lists el on el.id = ee.list_id
      join courses c on c.id = el.course_id
      where ee.student_id = v_permit.student_id
        and el.academic_session_id = v_permit.academic_session_id
        and el.status = 'authorized'
        and ee.eligible
    ), '[]'::jsonb)
  )
  into v_result
  from students s
  join profiles p on p.id = s.id
  join academic_sessions a on a.id = v_permit.academic_session_id
  where s.id = v_permit.student_id;

  return v_result;
end;
$$;

comment on function verify_exam_permit(text) is
  'Public permit check. Returns the name, matric number and papers — never percentages or dues history.';

revoke all on function issue_exam_permit(uuid, uuid) from public, anon, authenticated;
revoke all on function verify_exam_permit(text) from public, anon, authenticated;
grant execute on function issue_exam_permit(uuid, uuid) to service_role;
grant execute on function verify_exam_permit(text) to service_role;
