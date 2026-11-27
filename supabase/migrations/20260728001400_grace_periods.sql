-- Dept-Flow — opening and revoking a grace period
--
-- A grace period is the HOD saying: for these students, start recording
-- attendance again until this date, even though they have not paid.
--
-- It exists because locking is blunt and the cause is often not the student's.
-- A bursary disburses late, a bank is down for three days, a scholarship batch
-- does not land. Those lectures cannot be attended retroactively, so locking a
-- whole level out of them punishes the wrong people.

-- ---------------------------------------------------------------------------
-- Grace suspends the consequence; it does not change the state
-- ---------------------------------------------------------------------------

-- The obvious implementation — flip every locked student back to `uncleared` —
-- is wrong twice over. It destroys the fact that they were locked, so revoking
-- the grace period would have to guess who to re-lock. And it makes a student
-- under grace indistinguishable from one who never reached day 31, which is
-- exactly the distinction the HOD needs when the period expires.
--
-- So the state stays `locked` and the lock CHECK consults the grace period.
-- Revoking is then immediate and needs no compensating update, because nothing
-- was ever written to undo.
create or replace function is_attendance_locked(
  p_student_id uuid,
  p_academic_session_id uuid
)
returns boolean
language sql
stable
as $$
  select
    coalesce(
      (select cs.state = 'locked'
         from compliance_statuses cs
        where cs.student_id = p_student_id
          and cs.academic_session_id = p_academic_session_id),
      false
    )
    and not exists (
      select 1
      from grace_periods g
      join students s on s.id = p_student_id
      where g.academic_session_id = p_academic_session_id
        and g.revoked_at is null
        and g.expires_on >= current_date
        and (g.scope = 'department' or g.level = s.level)
    );
$$;

comment on function is_attendance_locked(uuid, uuid) is
  'True when the student is locked AND no active grace period covers them. Grace suspends the consequence rather than rewriting the state.';

-- ---------------------------------------------------------------------------
-- Who a grace period would reach
-- ---------------------------------------------------------------------------

-- Shown on the confirmation before it is opened, and stored on the row so the
-- history says what it did at the time rather than what it would do today.
create or replace function grace_period_impact(
  p_academic_session_id uuid,
  p_scope grace_scope,
  p_level integer default null
)
returns table (students_affected integer, sessions_waiting numeric)
language sql
stable
as $$
  with covered as (
    select cs.student_id
    from compliance_statuses cs
    join students s on s.id = cs.student_id
    where cs.academic_session_id = p_academic_session_id
      and cs.state = 'locked'
      and (p_scope = 'department' or s.level = p_level)
  )
  select
    (select count(*)::integer from covered),
    -- Marks already recorded and waiting on payment. The number the HOD is
    -- weighing: what these students stand to lose if nothing changes.
    coalesce((
      select sum(ss.score)
      from session_scores ss
      where ss.student_id in (select student_id from covered)
        and ss.status = 'provisional'
    ), 0);
$$;

-- ---------------------------------------------------------------------------
-- Opening one
-- ---------------------------------------------------------------------------

create or replace function open_grace_period(
  p_academic_session_id uuid,
  p_scope grace_scope,
  p_level integer,
  p_expires_on date,
  p_reason text,
  p_actor_id uuid
)
returns uuid
language plpgsql
as $$
declare
  v_id       uuid;
  v_students integer;
  v_waiting  numeric;
begin
  if p_actor_id is null then
    raise exception 'a grace period must record who opened it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a grace period must record why it was opened';
  end if;

  -- A date in the past would read as an active period that unlocks nobody.
  if p_expires_on <= current_date then
    raise exception 'a grace period must expire in the future';
  end if;

  -- One at a time per scope. Two overlapping periods make "when does this end"
  -- unanswerable, which is the only question a student in one will ask.
  if exists (
    select 1 from grace_periods g
    where g.academic_session_id = p_academic_session_id
      and g.revoked_at is null
      and g.expires_on >= current_date
      and (g.scope = 'department' or p_scope = 'department' or g.level = p_level)
  ) then
    raise exception 'a grace period covering these students is already open';
  end if;

  select students_affected, sessions_waiting
    into v_students, v_waiting
  from grace_period_impact(p_academic_session_id, p_scope, p_level);

  insert into grace_periods (
    academic_session_id, scope, level, expires_on, reason,
    granted_by, students_affected, sessions_waiting
  )
  values (
    p_academic_session_id, p_scope,
    case when p_scope = 'level' then p_level end,
    p_expires_on, btrim(p_reason),
    p_actor_id, coalesce(v_students, 0), coalesce(round(v_waiting), 0)
  )
  returning id into v_id;

  perform write_audit(
    p_actor_id, 'hod', 'grace_period.opened', 'grace_periods', v_id::text, btrim(p_reason),
    jsonb_build_object(
      'scope', p_scope,
      'level', p_level,
      'expires_on', p_expires_on,
      'students_affected', coalesce(v_students, 0)
    )
  );

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ending one early
-- ---------------------------------------------------------------------------

-- Takes effect immediately, because the lock check reads `revoked_at` live.
-- Nothing has to be re-locked: nobody was ever unlocked.
create or replace function revoke_grace_period(
  p_grace_id uuid,
  p_actor_id uuid,
  p_reason text
)
returns boolean
language plpgsql
as $$
declare
  v_row grace_periods%rowtype;
begin
  if p_actor_id is null then
    raise exception 'revoking a grace period must record who did it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'revoking a grace period must record why';
  end if;

  select * into v_row from grace_periods where id = p_grace_id;

  if v_row.id is null then return false; end if;
  if v_row.revoked_at is not null then return false; end if;

  update grace_periods
     set revoked_at = now(), revoked_by = p_actor_id
   where id = p_grace_id;

  perform write_audit(
    p_actor_id, 'hod', 'grace_period.revoked', 'grace_periods', p_grace_id::text, btrim(p_reason),
    jsonb_build_object('students_affected', v_row.students_affected)
  );

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function open_grace_period(uuid, grace_scope, integer, date, text, uuid)
  from public, anon, authenticated;
revoke all on function revoke_grace_period(uuid, uuid, text) from public, anon, authenticated;
grant execute on function open_grace_period(uuid, grace_scope, integer, date, text, uuid) to service_role;
grant execute on function revoke_grace_period(uuid, uuid, text) to service_role;

-- Read-only, and the HOD's own screen needs it before confirming.
revoke all on function grace_period_impact(uuid, grace_scope, integer) from public, anon;
grant execute on function grace_period_impact(uuid, grace_scope, integer) to authenticated, service_role;
