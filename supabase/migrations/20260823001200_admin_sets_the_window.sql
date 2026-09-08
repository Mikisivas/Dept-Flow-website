-- Dept-Flow — the admin setting the registration window
--
-- operational-flow.md §2.1 is one sentence: "Admin sets the registration window
-- (e.g., 7 days from resumption)." Everything downstream of it was built —
-- `registration_periods` holds one row per session and semester,
-- `is_registration_open()` reads it, `attendance_eligibility()` gates on it, and
-- /admin/config displays it — and the setting itself was not. The window could
-- only be created by someone with SQL access to the database.
--
-- That is a worse gap than it looks, because of which way the system fails when
-- the row is missing. A window that was never configured is treated as OPEN, on
-- purpose: failing the other way would bar a whole department from recording
-- attendance because nobody inserted a row. So the absence is silent. Nothing
-- breaks, no error is raised, and the registration gate — the mechanism the
-- August 2026 revision put at the centre of the system — simply never engages.
-- The department would find out at the end of the semester, from the absence of
-- the backfills that should have happened.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not touch a single registration. Moving a deadline changes who may
-- confirm from now on; it does not retroactively confirm, un-confirm, or
-- backfill anybody. The backfill belongs to `confirm_registration()`, at the
-- moment a student confirms, and computing it from a deadline edit would mean
-- two places deciding what a late registration costs.

create or replace function set_registration_period(
  p_actor_id            uuid,
  p_academic_session_id uuid,
  p_semester            smallint,
  p_opens_on            date,
  p_closes_on           date,
  p_reason              text
)
returns uuid
language plpgsql
as $$
declare
  v_id     uuid;
  v_before registration_periods%rowtype;
begin
  if not exists (select 1 from profiles where id = p_actor_id and role = 'admin') then
    raise exception 'only an administrator can set the registration window';
  end if;

  -- The same ten-character floor every other written justification in this
  -- system has. A deadline is the difference between a student recording
  -- attendance and being marked absent for every lecture until they confirm,
  -- and "changed" is not a reason anyone can act on a year later.
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'setting the registration window must record why';
  end if;

  if p_semester not in (1, 2) then
    raise exception 'a semester is 1 or 2';
  end if;

  if p_opens_on is null or p_closes_on is null then
    raise exception 'a window needs both an opening and a closing date';
  end if;

  -- Checked here as well as by the table constraint so the message is one a
  -- person can read. The constraint's own text names a constraint.
  if p_closes_on < p_opens_on then
    raise exception 'the window cannot close before it opens';
  end if;

  if not exists (select 1 from academic_sessions where id = p_academic_session_id) then
    raise exception 'that academic session does not exist';
  end if;

  select * into v_before
  from registration_periods
  where academic_session_id = p_academic_session_id and semester = p_semester;

  insert into registration_periods (academic_session_id, semester, opens_on, closes_on)
  values (p_academic_session_id, p_semester, p_opens_on, p_closes_on)
  on conflict (academic_session_id, semester) do update
    set opens_on  = excluded.opens_on,
        closes_on = excluded.closes_on
  returning id into v_id;

  -- Both the old dates and the new ones. A deadline that moved is the fact
  -- someone will be reconstructing later — usually while a student argues that
  -- they registered in time — and an audit row holding only the new value
  -- cannot answer them.
  perform write_audit(
    p_actor_id, 'admin', 'registration_period.set', 'registration_periods', v_id::text,
    btrim(p_reason),
    jsonb_build_object(
      'semester', p_semester,
      'opens_on', p_opens_on,
      'closes_on', p_closes_on,
      'previous_opens_on', v_before.opens_on,
      'previous_closes_on', v_before.closes_on,
      'created', v_before.id is null
    )
  );

  return v_id;
end;
$$;

revoke all on function set_registration_period(uuid, uuid, smallint, date, date, text)
  from public, anon, authenticated;
grant execute on function set_registration_period(uuid, uuid, smallint, date, date, text)
  to service_role;

comment on function set_registration_period(uuid, uuid, smallint, date, date, text) is
  'Opens or moves one semester''s registration window. Audited with the dates it replaced. Touches no registration: what a late confirmation costs is decided by confirm_registration(), not here.';
