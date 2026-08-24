-- Dept-Flow — payments that reconcile themselves (§8.4)
--
-- "A reconciliation job polls Paystack periodically for anything still
-- pending, to catch webhooks that never arrive."
--
-- Nobody should ever have to press a re-verify button. A student who has paid
-- and is waiting on a webhook that got lost is a student whose money the
-- department is holding without crediting, and the fix must not depend on
-- somebody noticing.
--
-- WHY THE SCHEDULE LIVES HERE AND NOT IN THE JOB
--
-- Two callers ask the same question — the background sweep, and the student's
-- own dues screen when they come back to look. If each carried its own "is
-- this one due yet" rule they would drift, and the drift would show up as
-- Paystack rate-limiting one path or the other going quiet. `next_check_at` is
-- a column: the rule is written once, and both callers reduce to `where
-- next_check_at <= now()`, which is one indexed read.
--
-- THE TWO THINGS THIS GETS RIGHT THAT A NAIVE POLLER GETS WRONG
--
-- 1. **Giving up asking is not giving up accepting.** After two days of
--    Paystack answering "pending", a checkout is abandoned and the row is
--    marked so — the student's screen stops saying "Checking payment…" for
--    ever. But `settle` still verifies an abandoned row, so a webhook that
--    arrives on day four still credits them. The polling stops; the door
--    does not close.
--
-- 2. **"Could not ask" is never recorded as "no".** A 500 from Paystack, a DNS
--    failure, an expired key — none of those are evidence about a student's
--    money. Those rows are rescheduled and NEVER abandoned, however many times
--    it happens. Only Paystack actually answering resolves a payment.

alter table payments
  -- How many times we have asked. Not for the backoff — the age drives that —
  -- but so a human looking at a stuck row can tell "asked once and failed"
  -- from "asked forty times and Paystack keeps saying pending".
  add column check_attempts integer not null default 0,
  -- When to ask next. Null means never again: either it is resolved, or we
  -- have stopped asking. The whole scheduler is this one column.
  add column next_check_at  timestamptz;

comment on column payments.next_check_at is
  'When the reconciliation sweep should next ask Paystack about this row. Null means stop asking — which is not the same as stop accepting: a late webhook still resolves an abandoned row.';

-- Partial, because it is only ever queried for pending rows and a full index
-- over every payment ever taken would be mostly dead weight.
create index payments_due_for_check_idx
  on payments (next_check_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- The backoff curve
-- ---------------------------------------------------------------------------

-- Shaped to how the money actually moves. A card settles in seconds and a
-- transfer in minutes, so the first minute belongs to the webhook — asking
-- during it would be racing our own notification for no reason. After that the
-- interval widens with the age of the payment, because a row still pending
-- after six hours is far more likely to be an abandoned checkout than a slow
-- one, and there is no sense spending a request a minute on it.
--
--   age < 2 min    →  ask again in 90 seconds
--   age < 30 min   →  every 2 minutes
--   age < 6 hours  →  every 15 minutes
--   age < 48 hours →  every 2 hours
--   age >= 48 h    →  stop asking, and call it abandoned
create or replace function schedule_payment_check(
  p_payment_id uuid,
  -- True when Paystack actually answered. False when we could not reach it,
  -- which is a fact about the network and not about the student.
  p_answered   boolean default true
)
returns timestamptz
language plpgsql
as $$
declare
  v_payment payments%rowtype;
  v_age     interval;
  v_next    timestamptz;
begin
  select * into v_payment from payments where id = p_payment_id;
  if v_payment.id is null then
    raise exception 'no such payment';
  end if;

  update payments
     set check_attempts = check_attempts + 1,
         last_checked_at = now()
   where id = p_payment_id;

  -- Resolved rows are never asked about again. Reaching here with one means a
  -- caller settled it and then scheduled anyway; harmless, and worth handling
  -- rather than leaving a resolved row with a live schedule.
  if v_payment.status <> 'pending' then
    update payments set next_check_at = null where id = p_payment_id;
    return null;
  end if;

  -- Paystack unreachable. Retry steadily and never abandon: we have learned
  -- nothing about this payment, and recording "abandoned" on the strength of
  -- our own network trouble would tell a student who paid that they did not.
  if not p_answered then
    v_next := now() + interval '10 minutes';
    update payments set next_check_at = v_next where id = p_payment_id;
    return v_next;
  end if;

  v_age := now() - v_payment.initialized_at;

  if v_age < interval '2 minutes' then
    v_next := now() + interval '90 seconds';
  elsif v_age < interval '30 minutes' then
    v_next := now() + interval '2 minutes';
  elsif v_age < interval '6 hours' then
    v_next := now() + interval '15 minutes';
  elsif v_age < interval '48 hours' then
    v_next := now() + interval '2 hours';
  else
    -- Two days of Paystack saying "pending" is a checkout nobody completed.
    -- Marked so the student's screen stops claiming something is in flight,
    -- and the schedule cleared so we stop spending requests on it.
    --
    -- `verified_at` stays null, which the payment_success_is_verified
    -- constraint requires and which is the honest record: nothing was verified
    -- because there was nothing to verify.
    update payments
       set status = 'abandoned',
           next_check_at = null
     where id = p_payment_id;
    return null;
  end if;

  update payments set next_check_at = v_next where id = p_payment_id;
  return v_next;
end;
$$;

revoke all on function schedule_payment_check(uuid, boolean) from public, anon, authenticated;
grant execute on function schedule_payment_check(uuid, boolean) to service_role;

comment on function schedule_payment_check(uuid, boolean) is
  'Widens the polling interval with the age of the payment, and abandons after two days of Paystack answering "pending". Never abandons on an unreachable Paystack — that is a fact about the network, not about the student.';

-- ---------------------------------------------------------------------------
-- What the sweep should pick up
-- ---------------------------------------------------------------------------

create or replace function payments_due_for_check(p_limit integer default 25)
returns table (
  payment_id uuid,
  reference  text,
  student_id uuid,
  attempts   integer,
  age_seconds integer
)
language sql
stable
as $$
  select
    p.id,
    p.paystack_reference,
    p.student_id,
    p.check_attempts,
    extract(epoch from (now() - p.initialized_at))::integer
  from payments p
  where p.status = 'pending'
    and p.next_check_at is not null
    and p.next_check_at <= now()
  -- Oldest first. A student who has been waiting since this morning is ahead
  -- of one who checked out ninety seconds ago, whatever else is in the queue.
  order by p.initialized_at
  limit greatest(1, least(p_limit, 200));
$$;

revoke all on function payments_due_for_check(integer) from public, anon, authenticated;
grant execute on function payments_due_for_check(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Every new payment is scheduled the moment it is written
-- ---------------------------------------------------------------------------

-- A trigger rather than the application remembering to do it. There is one
-- place a pending payment is created today and there may be two tomorrow, and
-- a payment that was never scheduled is invisible to the sweep — which is
-- precisely the failure this whole migration exists to remove.
create or replace function schedule_new_payment()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'pending' and new.next_check_at is null then
    -- Ninety seconds: long enough that the webhook usually beats us to it, so
    -- the common case costs Paystack nothing.
    new.next_check_at := now() + interval '90 seconds';
  end if;
  return new;
end;
$$;

create trigger payments_schedule_first_check
  before insert on payments
  for each row execute function schedule_new_payment();

-- Rows that predate this migration. Without the backfill the sweep would only
-- ever see payments taken after deployment, and the stuck ones this was built
-- to rescue — which are all older than it — would stay stuck for ever.
update payments
   set next_check_at = now()
 where status = 'pending'
   and next_check_at is null;

-- ---------------------------------------------------------------------------
-- Is reconciliation actually working?
-- ---------------------------------------------------------------------------

-- The failure mode that looks like health: the sweep is not scheduled, every
-- screen renders, and pending payments quietly pile up. `/api/health` reads
-- this, so the answer is one number rather than an investigation.
create or replace function reconciliation_health()
returns table (
  pending          integer,
  overdue          integer,
  oldest_overdue_seconds integer,
  stuck            integer
)
language sql
stable
as $$
  select
    count(*) filter (where status = 'pending')::integer,
    count(*) filter (where status = 'pending' and next_check_at <= now())::integer,
    coalesce(
      max(extract(epoch from (now() - next_check_at))) filter (
        where status = 'pending' and next_check_at <= now()
      ), 0
    )::integer,
    -- Asked many times and still unresolved. Either Paystack has been
    -- unreachable for hours or something is wrong with the key, and both are
    -- worth a person looking.
    count(*) filter (where status = 'pending' and check_attempts >= 10)::integer
  from payments;
$$;

revoke all on function reconciliation_health() from public, anon;
grant execute on function reconciliation_health() to authenticated, service_role;

comment on function reconciliation_health() is
  'Overdue is the number that matters: rows the sweep should already have picked up. Persistently above zero means the sweep is not running, which is the failure that looks like health.';
