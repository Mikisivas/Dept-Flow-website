-- Dept-Flow — the logic the whole system reduces to
--
-- These functions are the authoritative implementations. The API may cache
-- their results (Redis, for the compliance lookup during checkpoint bursts),
-- but it must not reimplement them.

-- ---------------------------------------------------------------------------
-- The one formula
-- ---------------------------------------------------------------------------

-- attendance % = (Σ confirmed scores) ÷ (lectures held) × 100
--
-- Digital sessions, single-checkpoint sessions and paper batches all feed this
-- identically — the source tag never touches the arithmetic. Cancelled
-- lectures are excluded from the denominator; provisional scores are excluded
-- from the numerator, which is exactly why an uncleared student sees a low
-- number and a truthful one.
create or replace function attendance_pct(
  p_student_id uuid,
  p_course_id uuid
)
returns numeric
language sql
stable
as $$
  with held as (
    select count(*)::numeric as n
    from session_instances si
    where si.course_id = p_course_id
      and si.status = 'closed'
  ),
  earned as (
    select coalesce(sum(ss.score), 0)::numeric as total
    from session_scores ss
    join session_instances si on si.id = ss.session_instance_id
    where ss.student_id = p_student_id
      and si.course_id = p_course_id
      and si.status = 'closed'
      and ss.status = 'confirmed'
  )
  select case
           when held.n = 0 then 0::numeric
           else round(earned.total / held.n * 100, 2)
         end
  from held, earned;
$$;

comment on function attendance_pct(uuid, uuid) is
  'The exam-eligibility formula. Confirmed scores only, over lectures held.';

-- How many further full sessions reach the threshold, given that each one adds
-- to both sides of the fraction. This is the number in the AttendanceMeter
-- sentence: "You need 4 more full sessions to reach 75%."
create or replace function full_sessions_needed(
  p_earned numeric,
  p_held numeric,
  p_threshold_pct numeric default 75.00
)
returns integer
language sql
immutable
as $$
  select greatest(
    0,
    ceil(
      ((p_threshold_pct / 100.0) * p_held - p_earned)
      / nullif(1 - (p_threshold_pct / 100.0), 0)
    )::integer
  );
$$;

-- ---------------------------------------------------------------------------
-- Scoring a lecture
-- ---------------------------------------------------------------------------

-- Two accepted checkpoints = 1.0, one = 0.5, none = 0. A single-checkpoint
-- lecture is binary. The score is written CONFIRMED if the student is cleared
-- and PROVISIONAL otherwise — the recording never depends on payment, only the
-- counting does.
create or replace function resolve_session_score(
  p_student_id uuid,
  p_session_instance_id uuid,
  p_source score_source default 'digital',
  p_manual_batch_id uuid default null
)
returns numeric
language plpgsql
as $$
declare
  v_mode          checkpoint_mode;
  v_accepted      integer;
  v_score         numeric(2,1);
  v_status        score_status;
  v_academic_session uuid;
  v_compliance    compliance_state;
begin
  select si.checkpoint_mode, c.academic_session_id
    into v_mode, v_academic_session
  from session_instances si
  join courses c on c.id = si.course_id
  where si.id = p_session_instance_id;

  if v_mode is null then
    raise exception 'cannot score a session that has not closed';
  end if;

  select count(*)
    into v_accepted
  from attendance_marks am
  join checkpoints cp on cp.id = am.checkpoint_id
  where am.student_id = p_student_id
    and cp.session_instance_id = p_session_instance_id
    and am.accepted;

  if v_mode = 'single' then
    v_score := case when v_accepted >= 1 then 1.0 else 0 end;
  else
    v_score := case v_accepted when 2 then 1.0 when 1 then 0.5 else 0 end;
  end if;

  select cs.state into v_compliance
  from compliance_statuses cs
  where cs.student_id = p_student_id
    and cs.academic_session_id = v_academic_session;

  v_status := case when v_compliance = 'cleared' then 'confirmed' else 'provisional' end;

  insert into session_scores (
    student_id, session_instance_id, score, status, source, manual_batch_id, confirmed_at
  )
  values (
    p_student_id,
    p_session_instance_id,
    v_score,
    v_status,
    p_source,
    p_manual_batch_id,
    case when v_status = 'confirmed' then now() end
  )
  on conflict (student_id, session_instance_id) do update
    set score           = excluded.score,
        status          = excluded.status,
        source          = excluded.source,
        manual_batch_id = excluded.manual_batch_id,
        confirmed_at    = excluded.confirmed_at;

  return v_score;
end;
$$;

-- ---------------------------------------------------------------------------
-- The compliance transition
-- ---------------------------------------------------------------------------

-- Clearing is one transaction: the student's state flips and every provisional
-- score for that academic session becomes confirmed together. Partially
-- confirmed is not a state this system has.
create or replace function clear_student(
  p_student_id uuid,
  p_academic_session_id uuid,
  p_route clearance_route,
  p_actor_id uuid default null
)
returns integer
language plpgsql
as $$
declare
  v_confirmed integer;
begin
  if p_route <> 'payment' and p_actor_id is null then
    raise exception 'a clearance granted by a person must record who granted it';
  end if;

  insert into compliance_statuses (
    student_id, academic_session_id, state, cleared_at, cleared_via, cleared_by
  )
  values (
    p_student_id, p_academic_session_id, 'cleared', now(), p_route, p_actor_id
  )
  on conflict (student_id, academic_session_id) do update
    set state         = 'cleared',
        cleared_at    = now(),
        cleared_via   = p_route,
        cleared_by    = p_actor_id,
        pending_since = null,
        locked_at     = null;

  with flipped as (
    update session_scores ss
       set status = 'confirmed',
           confirmed_at = now()
      from session_instances si
      join courses c on c.id = si.course_id
     where ss.session_instance_id = si.id
       and ss.student_id = p_student_id
       and ss.status = 'provisional'
       and c.academic_session_id = p_academic_session_id
    returning 1
  )
  select count(*) into v_confirmed from flipped;

  return v_confirmed;
end;
$$;

comment on function clear_student(uuid, uuid, clearance_route, uuid) is
  'Flips compliance to cleared and confirms every provisional score in the same transaction. Returns the number of sessions counted.';

-- Day 31: uncleared students enter the buffer rather than locking immediately,
-- because a transfer that settled late is not the same as a student who never
-- paid.
create or replace function begin_pending_verification(p_academic_session_id uuid)
returns integer
language plpgsql
as $$
declare
  v_moved integer;
begin
  with moved as (
    update compliance_statuses cs
       set state = 'pending_verification',
           pending_since = now()
     where cs.academic_session_id = p_academic_session_id
       and cs.state = 'uncleared'
    returning 1
  )
  select count(*) into v_moved from moved;

  return v_moved;
end;
$$;

-- Buffer expiry: no new attendance can be recorded, and provisional scores
-- stay unconfirmed rather than being deleted.
create or replace function lock_after_buffer(p_academic_session_id uuid)
returns integer
language plpgsql
as $$
declare
  v_buffer_hours integer;
  v_locked integer;
begin
  select pending_verification_buffer_hours into v_buffer_hours from app_config where id = 1;

  with locked as (
    update compliance_statuses cs
       set state = 'locked',
           locked_at = now()
     where cs.academic_session_id = p_academic_session_id
       and cs.state = 'pending_verification'
       and cs.pending_since < now() - make_interval(hours => v_buffer_hours)
    returning 1
  )
  select count(*) into v_locked from locked;

  return v_locked;
end;
$$;

-- The hot-path check on the attendance-submission endpoint. Redis caches this
-- during token windows; this is the source of truth behind the cache.
create or replace function is_attendance_locked(
  p_student_id uuid,
  p_academic_session_id uuid
)
returns boolean
language sql
stable
as $$
  select coalesce(
    (select cs.state = 'locked'
       from compliance_statuses cs
      where cs.student_id = p_student_id
        and cs.academic_session_id = p_academic_session_id),
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------

-- Raw coordinates are dropped on schedule; the derived distance and the
-- pass/fail record stay. Run nightly.
create or replace function purge_expired_coordinates()
returns integer
language plpgsql
as $$
declare
  v_days integer;
  v_purged integer;
begin
  select gps_retention_days into v_days from app_config where id = 1;

  with purged as (
    update attendance_marks
       set gps_lat = null,
           gps_lng = null,
           coordinates_purged_at = now()
     where coordinates_purged_at is null
       and submitted_at < now() - make_interval(days => v_days)
    returning 1
  )
  select count(*) into v_purged from purged;

  return v_purged;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

create or replace function write_audit(
  p_actor_id uuid,
  p_actor_role app_role,
  p_action text,
  p_target_table text default null,
  p_target_id text default null,
  p_reason text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language sql
as $$
  insert into audit_log (actor_id, actor_role, action, target_table, target_id, reason, metadata)
  values (p_actor_id, p_actor_role, p_action, p_target_table, p_target_id, p_reason, p_metadata)
  returning id;
$$;

-- ---------------------------------------------------------------------------
-- Display
-- ---------------------------------------------------------------------------

-- Register order: 'OKONKWO, Chidera Emeka'. Used in tables, rosters and the
-- eligibility list, where sorting and disambiguation matter.
create or replace function display_name_register(
  p_surname text,
  p_first_name text,
  p_other_names text default null
)
returns text
language sql
immutable
as $$
  select upper(p_surname) || ', ' || btrim(p_first_name ||
         case when coalesce(btrim(p_other_names), '') = '' then '' else ' ' || p_other_names end);
$$;

-- Conversational order: 'Chidera Okonkwo'. Used in greetings and the account
-- menu.
create or replace function display_name_familiar(
  p_surname text,
  p_first_name text
)
returns text
language sql
immutable
as $$
  select p_first_name || ' ' || p_surname;
$$;
