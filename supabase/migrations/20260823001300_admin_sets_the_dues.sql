-- Dept-Flow — the admin setting the dues for a session
--
-- The companion to ..._admin_sets_the_window.sql, and the last configuration
-- value that could only be written with SQL access. /admin/config displays the
-- dues amount and the resumption date, and shows an alert when no dues period
-- exists at all — "there is no day 0 to count from" — which told the admin
-- something was wrong and gave them no way to fix it.
--
-- ONE ROW PER SESSION, NOT PER SEMESTER
--
-- `dues_periods.academic_session_id` is UNIQUE, and that is the right shape:
-- departmental dues are charged once for the year, not once a term. The
-- registration window is the per-semester one. Keeping the two apart matters
-- because they are set on the same screen and would otherwise invite a second
-- dues row that nothing would ever read — `dues_balance_kobo()` selects the
-- session's row without a semester, so a per-semester dues row would silently
-- be ignored or, worse, picked arbitrarily.
--
-- WHAT CHANGING THE AMOUNT ACTUALLY DOES
--
-- Every consequential reader of dues computes from this number live rather than
-- from anything stored: `dues_balance_kobo()` subtracts what a student has paid
-- from it on every call, the permit's dues gate reads that balance, and so does
-- the HOD's payment compliance report. So raising the amount does not need a
-- migration or a recompute — it takes effect everywhere at once.
--
-- Which is exactly why it is dangerous. Raising the figure after students have
-- paid puts every one of them back in debt and stops their exam permits, with
-- no other symptom. `dues_change_impact()` below exists so that number is on the
-- screen before the change is made rather than discovered from the permit queue.

-- ---------------------------------------------------------------------------
-- Who a new amount would move across the line
-- ---------------------------------------------------------------------------

create or replace function dues_change_impact(
  p_academic_session_id uuid,
  p_amount_kobo double precision
)
returns table (
  students           integer,
  paid_in_full_now   integer,
  paid_in_full_after integer,
  newly_owing        integer
)
language sql
stable
as $$
  with paid as (
    select
      s.id,
      dues_paid_kobo(s.id, p_academic_session_id) as paid,
      coalesce((select dp.dues_amount_kobo from dues_periods dp
                 where dp.academic_session_id = p_academic_session_id), 0) as current_amount
    from students s
    where s.status <> 'deactivated'
  )
  select
    count(*)::integer,
    -- The same 1-kobo tolerance payment_matches_dues() uses. Amounts are double
    -- precision, so "paid exactly the fee" is not a float equality anyone should
    -- be writing twice with different slack.
    count(*) filter (where paid >= current_amount - 1.0)::integer,
    count(*) filter (where paid >= p_amount_kobo - 1.0)::integer,
    -- The number the decision turns on: students who owe nothing today and
    -- would owe something tomorrow. Each one loses a permit they could print
    -- this morning.
    count(*) filter (
      where paid >= current_amount - 1.0
        and paid < p_amount_kobo - 1.0
    )::integer
  from paid;
$$;

revoke all on function dues_change_impact(uuid, double precision) from public, anon;
grant execute on function dues_change_impact(uuid, double precision)
  to authenticated, service_role;

comment on function dues_change_impact(uuid, double precision) is
  'What a new dues figure would do to the people already paying it. newly_owing is the one that matters: students clear today who would owe tomorrow, and lose a permit for it.';

-- ---------------------------------------------------------------------------
-- Setting it
-- ---------------------------------------------------------------------------

create or replace function set_dues_period(
  p_actor_id            uuid,
  p_academic_session_id uuid,
  p_resumption_date     date,
  p_dues_amount_kobo    double precision,
  p_reason              text
)
returns uuid
language plpgsql
as $$
declare
  v_id      uuid;
  v_before  dues_periods%rowtype;
  v_impact  record;
begin
  if not exists (select 1 from profiles where id = p_actor_id and role = 'admin') then
    raise exception 'only an administrator can set the dues';
  end if;

  -- The HOD is excluded here deliberately, and it is a separation-of-duties
  -- line rather than an oversight: §2 says the HOD approves waivers and cannot
  -- edit the dues amount. Someone who can both forgive a debt and decide what
  -- the debt is has no second pair of eyes on either.
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'setting the dues must record why';
  end if;

  if p_resumption_date is null then
    raise exception 'a dues period needs a resumption date — it is day 0';
  end if;

  if p_dues_amount_kobo is null or p_dues_amount_kobo <= 0 then
    raise exception 'the dues amount must be more than zero';
  end if;

  -- Whole kobo. The table constraint says the same thing; saying it here makes
  -- the refusal readable instead of naming a constraint.
  if p_dues_amount_kobo <> trunc(p_dues_amount_kobo) then
    raise exception 'the dues amount must be a whole number of kobo';
  end if;

  if not exists (select 1 from academic_sessions where id = p_academic_session_id) then
    raise exception 'that academic session does not exist';
  end if;

  select * into v_before
  from dues_periods
  where academic_session_id = p_academic_session_id;

  -- Measured BEFORE the write, because it compares the new figure against the
  -- one still in place. Afterwards there is nothing left to compare with.
  select * into v_impact
  from dues_change_impact(p_academic_session_id, p_dues_amount_kobo);

  insert into dues_periods (academic_session_id, resumption_date, dues_amount_kobo)
  values (p_academic_session_id, p_resumption_date, p_dues_amount_kobo)
  on conflict (academic_session_id) do update
    set resumption_date  = excluded.resumption_date,
        dues_amount_kobo = excluded.dues_amount_kobo
  returning id into v_id;

  perform write_audit(
    p_actor_id, 'admin', 'dues_period.set', 'dues_periods', v_id::text,
    btrim(p_reason),
    jsonb_build_object(
      'resumption_date', p_resumption_date,
      'dues_amount_kobo', p_dues_amount_kobo,
      'previous_resumption_date', v_before.resumption_date,
      'previous_dues_amount_kobo', v_before.dues_amount_kobo,
      'created', v_before.id is null,
      -- Recorded, not just previewed. "How many students did that raise put
      -- back in debt?" is asked months later, by which time the screen that
      -- showed it is long gone.
      'newly_owing', v_impact.newly_owing
    )
  );

  return v_id;
end;
$$;

revoke all on function set_dues_period(uuid, uuid, date, double precision, text)
  from public, anon, authenticated;
grant execute on function set_dues_period(uuid, uuid, date, double precision, text)
  to service_role;

comment on function set_dues_period(uuid, uuid, date, double precision, text) is
  'Sets the session''s dues amount and resumption date. One row per session, never per semester. Audited with the figures it replaced and how many students the change put back in debt.';
