-- Dept-Flow — making the deadline actually arrive
--
-- Two functions have existed since the first migration and nothing has ever
-- called them: `begin_pending_verification` and `lock_after_buffer`. The whole
-- compliance ladder — uncleared → pending verification → locked — was inert.
--
-- That was survivable while locking only affected attendance recording, since
-- the seed sets a locked student by hand. It stopped being survivable when the
-- payment window was tied to the lock: with nothing to drive the transition, no
-- student is ever locked, the portal never closes, and the deadline the
-- department asked for does not exist.

-- ---------------------------------------------------------------------------
-- The deadline belongs in the function, not in the caller
-- ---------------------------------------------------------------------------

-- The original moved EVERY uncleared student into the buffer whenever it was
-- called. The day-30 rule lived entirely in the assumption that somebody would
-- call it on day 31 and never a day sooner — so a scheduler misfire, a manual
-- run, or a retry would lock a whole department early, and the students would
-- have no way to pay their way out of it.
--
-- The rule now lives here: resumption date plus the configured provisional
-- window. Running this on day 3 does nothing at all.
create or replace function begin_pending_verification(p_academic_session_id uuid)
returns integer
language plpgsql
as $$
declare
  v_days     integer;
  v_deadline date;
  v_moved    integer;
begin
  select provisional_window_days into v_days from app_config where id = 1;

  select dp.resumption_date + v_days
    into v_deadline
  from dues_periods dp
  where dp.academic_session_id = p_academic_session_id;

  -- No dues period means no deadline to have passed.
  if v_deadline is null or current_date <= v_deadline then
    return 0;
  end if;

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

comment on function begin_pending_verification(uuid) is
  'Day 31 onwards. Safe to run any day: before the deadline it moves nobody.';

-- ---------------------------------------------------------------------------
-- One call for the scheduler
-- ---------------------------------------------------------------------------

-- Both steps in order, for the active session. Separate functions would mean a
-- scheduler that ran one and not the other leaves students in the buffer for
-- ever, which is the state where they can neither record attendance nor be
-- chased about it.
create or replace function advance_compliance_states()
returns table (moved_to_pending integer, locked integer)
language plpgsql
as $$
declare
  v_session uuid;
  v_pending integer;
  v_locked  integer;
begin
  select id into v_session from academic_sessions where is_active limit 1;

  if v_session is null then
    return query select 0, 0;
    return;
  end if;

  v_pending := begin_pending_verification(v_session);
  v_locked  := lock_after_buffer(v_session);

  -- Audited only when something actually changed. A nightly no-op writing a
  -- row every night would bury the nights that mattered.
  if v_pending > 0 or v_locked > 0 then
    perform write_audit(
      null, 'admin', 'compliance.advanced', 'compliance_statuses', v_session::text,
      'Scheduled compliance transition',
      jsonb_build_object('moved_to_pending', v_pending, 'locked', v_locked)
    );
  end if;

  return query select v_pending, v_locked;
end;
$$;

revoke all on function advance_compliance_states() from public, anon, authenticated;
grant execute on function advance_compliance_states() to service_role;

-- ---------------------------------------------------------------------------
-- Scheduling it
-- ---------------------------------------------------------------------------

-- Supabase ships pg_cron. Enable it under Database → Extensions, then run:
--
--   select cron.schedule(
--     'dept-flow-compliance',
--     '0 1 * * *',                       -- 01:00 UTC, i.e. 02:00 in Lagos
--     $$select advance_compliance_states()$$
--   );
--
-- Running it inside the database is preferable to an HTTP cron hitting the app:
-- one less moving part, no shared secret to leak, and it keeps working when the
-- web deployment is down or being redeployed.
--
-- `/api/cron/compliance` exists as well, for hosts without pg_cron. Both call
-- the same function, and both are safe to run repeatedly — the transitions are
-- idempotent by their own conditions rather than by remembering they ran.
