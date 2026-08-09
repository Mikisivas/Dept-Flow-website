-- Dept-Flow — the administrator's authority actions
--
-- Four writes that only the registry side performs. All four follow the shape
-- every other authority action in this schema follows: an actor, a written
-- reason, an audit row, and the rule enforced here rather than in the API, so
-- it holds for anything that ever writes these tables.
--
-- The screens for all four already existed. None of them called anything: the
-- deactivate dialog changed a row in the browser's memory and the student could
-- still log in.

-- ---------------------------------------------------------------------------
-- Deactivating a student
-- ---------------------------------------------------------------------------

-- A soft delete, and the word "delete" is wrong for it in both directions.
-- Nothing is removed — attendance, payments and audit rows all survive, because
-- the commonest reason to look up a withdrawn student is a dispute about the
-- term they were still here for. What stops is the login.
create or replace function deactivate_student(
  p_student_id uuid,
  p_actor_id   uuid,
  p_reason     deactivation_reason,
  p_note       text
)
returns text
language plpgsql
as $$
declare
  v_row students%rowtype;
begin
  if p_actor_id is null then
    raise exception 'a deactivation must record who made it';
  end if;

  -- 'other' already demands a note at the table level. Demanding one for every
  -- reason is the difference between a log that explains itself and a log of
  -- the word "Withdrawn" four hundred times.
  if length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'a deactivation must record why';
  end if;

  select * into v_row from students where id = p_student_id;

  if v_row.id is null then return 'not_found'; end if;
  if v_row.status = 'deactivated' then return 'already_deactivated'; end if;

  update students
     set status              = 'deactivated',
         deactivation_reason = p_reason,
         deactivation_note   = btrim(p_note),
         deactivated_by      = p_actor_id,
         deactivated_at      = now()
   where id = p_student_id;

  perform write_audit(
    p_actor_id, 'admin', 'student.deactivate', 'students', p_student_id::text, btrim(p_note),
    jsonb_build_object('matric_no', v_row.matric_no, 'reason', p_reason, 'level', v_row.level)
  );

  return 'deactivated';
end;
$$;

comment on function deactivate_student(uuid, uuid, deactivation_reason, text) is
  'Stops the login. Keeps every row. The matric number stays retired rather than being freed for reuse.';

-- Reversible, because the commonest cause of a deactivation is a clerical
-- error and the second commonest is a withdrawal the student then reversed.
create or replace function reactivate_student(
  p_student_id uuid,
  p_actor_id   uuid,
  p_note       text
)
returns text
language plpgsql
as $$
declare
  v_row students%rowtype;
begin
  if p_actor_id is null then
    raise exception 'a reactivation must record who made it';
  end if;

  if length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'a reactivation must record why';
  end if;

  select * into v_row from students where id = p_student_id;

  if v_row.id is null then return 'not_found'; end if;
  if v_row.status <> 'deactivated' then return 'not_deactivated'; end if;

  update students
     set status              = 'active',
         deactivation_reason = null,
         deactivation_note   = null,
         deactivated_by      = null,
         deactivated_at      = null
   where id = p_student_id;

  -- The old reason is carried into the audit row before it is cleared, so
  -- reactivating does not erase the record of what was undone.
  perform write_audit(
    p_actor_id, 'admin', 'student.reactivate', 'students', p_student_id::text, btrim(p_note),
    jsonb_build_object(
      'matric_no', v_row.matric_no,
      'previous_reason', v_row.deactivation_reason,
      'previous_note', v_row.deactivation_note
    )
  );

  return 'reactivated';
end;
$$;

-- ---------------------------------------------------------------------------
-- Registration disputes
-- ---------------------------------------------------------------------------

-- Someone reports that their matric number was claimed by another person. Two
-- outcomes: the claim was fraudulent and the account is revoked, or it was not
-- and the report is dismissed. Both are decisions and both are written down —
-- a dismissal with no record is how the same student is asked to prove the
-- same thing three times.
create or replace function resolve_registration_dispute(
  p_dispute_id uuid,
  p_actor_id   uuid,
  p_revoke     boolean,
  p_reason     text
)
returns text
language plpgsql
as $$
declare
  v_row      registration_disputes%rowtype;
  v_student  students%rowtype;
  v_revoked  boolean := false;
begin
  if p_actor_id is null then
    raise exception 'a dispute resolution must record who made it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a dispute resolution must record why';
  end if;

  select * into v_row from registration_disputes where id = p_dispute_id;

  if v_row.id is null then return 'not_found'; end if;
  if v_row.status <> 'open' then return 'already_resolved'; end if;

  if p_revoke then
    select * into v_student from students where matric_no = v_row.matric_no;

    -- Through deactivate_student rather than by hand. One code path for "how a
    -- student stops being able to log in" means the table's own invariants
    -- cannot drift apart between the two callers, and it writes its own audit
    -- row — so someone asking "why is this account closed?" finds the answer
    -- under `student.deactivate`, where they would look, rather than having to
    -- know that registration revocations record it somewhere else.
    if v_student.id is not null then
      v_revoked := deactivate_student(v_student.id, p_actor_id, 'other', btrim(p_reason)) = 'deactivated';
    end if;

    -- Releasing the register row is the point of revoking. The real student
    -- has to be able to register afterwards, and they cannot while their own
    -- matric number is still marked claimed.
    update whitelist_entries
       set claimed    = false,
           claimed_by = null,
           claimed_at = null
     where matric_no = v_row.matric_no
       and academic_session_id = v_row.academic_session_id;
  end if;

  update registration_disputes
     set status            = (case when p_revoke then 'corrected' else 'upheld' end)::dispute_status,
         resolution_reason = btrim(p_reason),
         resolved_by       = p_actor_id,
         resolved_at       = now()
   where id = p_dispute_id;

  perform write_audit(
    p_actor_id, 'admin',
    case when p_revoke then 'registration.revoke' else 'registration.dispute_dismissed' end,
    'registration_disputes', p_dispute_id::text, btrim(p_reason),
    jsonb_build_object(
      'matric_no', v_row.matric_no,
      'account_revoked', v_revoked,
      'register_row_released', p_revoke
    )
  );

  return case when p_revoke then 'revoked' else 'dismissed' end;
end;
$$;

comment on function resolve_registration_dispute(uuid, uuid, boolean, text) is
  'Revoking deactivates the claiming account AND frees the register row, so the real student can register.';

-- ---------------------------------------------------------------------------
-- Level rollover
-- ---------------------------------------------------------------------------

-- The single most destructive write in the system: it changes the level of
-- every student in the department at once, and level is what decides which
-- courses they are enrolled in.
--
-- Three protections, in order of how much each has to be relied on:
--   1. It refuses to run twice for the same pair of sessions.
--   2. Graduands are marked BEFORE anyone is promoted, so the 400s that leave
--      are the 400s that were there when it started, not the 300s that just
--      arrived. Doing it in the other order graduates the wrong cohort — an
--      error nobody would catch until final results.
--   3. It is one transaction, so a failure halfway leaves no half-promoted
--      department.
create or replace function run_level_rollover(
  p_to_session_id uuid,
  p_actor_id      uuid,
  p_note          text
)
returns table (promoted integer, graduating integer)
language plpgsql
as $$
declare
  v_from       uuid;
  v_promoted   integer;
  v_graduating integer;
begin
  if p_actor_id is null then
    raise exception 'a level rollover must record who ran it';
  end if;

  if length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'a level rollover must record why';
  end if;

  select id into v_from from academic_sessions where is_active limit 1;

  if v_from is null then
    raise exception 'there is no active session to roll over from';
  end if;

  if p_to_session_id = v_from then
    raise exception 'a session cannot be rolled over into itself';
  end if;

  if not exists (select 1 from academic_sessions where id = p_to_session_id) then
    raise exception 'the session being rolled into does not exist';
  end if;

  if exists (
    select 1 from level_rollovers
    where from_academic_session_id = v_from and to_academic_session_id = p_to_session_id
  ) then
    raise exception 'this rollover has already been run';
  end if;

  -- Step 1: the leaving cohort, identified before anything moves.
  with graduands as (
    update students
       set status = 'graduating'
     where status = 'active' and level = 400
    returning 1
  )
  select count(*) into v_graduating from graduands;

  -- Step 2: everybody else moves up one level.
  with promotions as (
    update students
       set level = level + 100
     where status = 'active' and level < 400
    returning 1
  )
  select count(*) into v_promoted from promotions;

  -- Step 3: a new session means dues are owed again, so every continuing
  -- student starts it uncleared. Without this they carry no compliance row at
  -- all, and a student with no row is indistinguishable from one who has paid
  -- on any screen that reads the state directly.
  insert into compliance_statuses (student_id, academic_session_id, state)
  select s.id, p_to_session_id, 'uncleared'
  from students s
  where s.status = 'active'
  on conflict (student_id, academic_session_id) do nothing;

  -- Step 4: the new session becomes the current one. Deliberately part of the
  -- same transaction — promoting everyone and then forgetting to switch over
  -- leaves the department at the right levels in the wrong year, which is
  -- harder to detect than either half failing outright.
  update academic_sessions set is_active = false where id = v_from;
  update academic_sessions set is_active = true  where id = p_to_session_id;

  insert into level_rollovers (
    from_academic_session_id, to_academic_session_id,
    students_promoted, students_graduating, run_by, note
  )
  values (v_from, p_to_session_id, v_promoted, v_graduating, p_actor_id, btrim(p_note));

  perform write_audit(
    p_actor_id, 'admin', 'level.rollover', 'academic_sessions', p_to_session_id::text, btrim(p_note),
    jsonb_build_object(
      'from_session', v_from,
      'to_session', p_to_session_id,
      'promoted', v_promoted,
      'graduating', v_graduating
    )
  );

  return query select v_promoted, v_graduating;
end;
$$;

comment on function run_level_rollover(uuid, uuid, text) is
  'Marks graduands first, then promotes, then opens the new session uncleared. Refuses a second run for the same pair.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function deactivate_student(uuid, uuid, deactivation_reason, text) from public, anon, authenticated;
revoke all on function reactivate_student(uuid, uuid, text) from public, anon, authenticated;
revoke all on function resolve_registration_dispute(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function run_level_rollover(uuid, uuid, text) from public, anon, authenticated;

grant execute on function deactivate_student(uuid, uuid, deactivation_reason, text) to service_role;
grant execute on function reactivate_student(uuid, uuid, text) to service_role;
grant execute on function resolve_registration_dispute(uuid, uuid, boolean, text) to service_role;
grant execute on function run_level_rollover(uuid, uuid, text) to service_role;
