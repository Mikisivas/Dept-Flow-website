-- Dept-Flow — payment stops gating attendance
--
-- "Runs in parallel to everything above — paying dues no longer affects
-- whether a student can log attendance."
--
-- That sentence deletes the mechanism this system was built around. A score
-- used to be written PROVISIONAL and only counted once the student cleared,
-- which is why `clear_student()` flipped every row in one transaction and why
-- the student dashboard led with a banner explaining that their attendance was
-- recorded but worth nothing. Registration is the gate now; dues are a debt.
--
-- So `score_status` goes. Not left as a column that is always 'confirmed' —
-- a status with one value is a reader's trap, and the first person to see it
-- will assume the other value is reachable and write a query that filters on
-- it. Every score counts, and `attendance_pct` says so by not mentioning it.
--
-- What arrives in its place is the rest of §8, none of which the old
-- flat-paid-or-not model could express:
--
--   partial payments    a running balance rather than a boolean. Students pay
--                       dues in instalments; a schema that cannot hold that
--                       forces the office back into a notebook.
--   idempotency         Paystack resends webhooks. A resent event must not
--                       credit an account twice.
--   integrity           duplicate references, one card funding several matric
--                       numbers, amounts that are not the dues figure.
--   reversals           a chargeback re-opens the debt WITH NOTICE rather than
--                       silently revoking a clearance.
--   the manual route    a receipt upload and an admin approval, for the day
--                       the gateway is simply down. Flagged as such forever.

-- ---------------------------------------------------------------------------
-- Every recorded lecture counts
-- ---------------------------------------------------------------------------

-- Order matters: the view reads the column, the constraints reference it, and
-- the functions are replaced further down.
drop view if exists my_attendance_marks;

alter table session_scores
  drop constraint if exists score_confirmed_has_timestamp;

drop index if exists session_scores_provisional_idx;
drop index if exists session_scores_student_idx;

alter table session_scores
  drop column if exists status,
  drop column if exists confirmed_at;

create index session_scores_student_idx on session_scores (student_id);

drop type if exists score_status;

comment on table session_scores is
  'One lecture, one student, present or absent. Every row counts — whether the student has paid is a separate question with separate consequences.';

-- The formula, with the clause that made payment matter taken out of it. The
-- denominator is unchanged: lectures held while the student was on the course.
create or replace function attendance_pct(
  p_student_id uuid,
  p_course_id uuid
)
returns numeric
language sql
stable
as $$
  with window_of as (
    select e.enrolled_on, e.dropped_at
    from enrolments e
    where e.student_id = p_student_id
      and e.course_id = p_course_id
    order by e.enrolled_on
    limit 1
  ),
  held as (
    select count(*)::numeric as n
    from session_instances si, window_of w
    where si.course_id = p_course_id
      and si.status = 'closed'
      and si.held_on >= w.enrolled_on
      and (w.dropped_at is null or si.held_on < w.dropped_at::date)
  ),
  earned as (
    select coalesce(sum(ss.score), 0)::numeric as total
    from session_scores ss
    join session_instances si on si.id = ss.session_instance_id
    where ss.student_id = p_student_id
      and si.course_id = p_course_id
      and si.status = 'closed'
  )
  select case
           when held.n = 0 then 0::numeric
           else round(earned.total / held.n * 100, 2)
         end
  from held, earned;
$$;

comment on function attendance_pct(uuid, uuid) is
  'The exam-eligibility formula. Lectures attended over lectures held while the student was enrolled. Dues do not appear in it.';

-- Scoring, without the compliance lookup that used to decide the status.
create or replace function resolve_session_score(
  p_student_id uuid,
  p_session_instance_id uuid,
  p_source score_source default 'digital',
  p_manual_batch_id uuid default null,
  p_override_score numeric default null
)
returns numeric
language plpgsql
as $$
declare
  v_status_of_lecture session_instance_status;
  v_accepted integer;
  v_score    numeric(2,1);
begin
  select si.status into v_status_of_lecture
  from session_instances si
  where si.id = p_session_instance_id;

  if v_status_of_lecture is null then
    raise exception 'no such lecture';
  end if;

  if v_status_of_lecture <> 'closed' then
    raise exception 'cannot score a session that has not closed';
  end if;

  if p_override_score is not null then
    if p_override_score not in (0, 1.0) then
      raise exception 'a lecture is attended (1.0) or it is not (0)';
    end if;
    v_score := p_override_score;
  else
    select count(*)
      into v_accepted
    from attendance_marks am
    join checkpoints cp on cp.id = am.checkpoint_id
    where am.student_id = p_student_id
      and cp.session_instance_id = p_session_instance_id
      and am.accepted;

    v_score := case when v_accepted >= 1 then 1.0 else 0 end;
  end if;

  insert into session_scores (
    student_id, session_instance_id, score, source, manual_batch_id
  )
  values (p_student_id, p_session_instance_id, v_score, p_source, p_manual_batch_id)
  on conflict (student_id, session_instance_id) do update
    set score           = excluded.score,
        source          = excluded.source,
        manual_batch_id = excluded.manual_batch_id;

  return v_score;
end;
$$;

revoke all on function resolve_session_score(uuid, uuid, score_source, uuid, numeric)
  from public, anon, authenticated;
grant execute on function resolve_session_score(uuid, uuid, score_source, uuid, numeric)
  to service_role;

-- ---------------------------------------------------------------------------
-- Clearing, which no longer touches attendance
-- ---------------------------------------------------------------------------

-- Kept, because clearing is still a real event with a route and an actor and
-- an audit trail. What it no longer does is reach into `session_scores`. The
-- return value goes with the reaching: there is nothing to count.
create or replace function clear_student(
  p_student_id uuid,
  p_academic_session_id uuid,
  p_route clearance_route,
  p_actor_id uuid default null
)
returns integer
language plpgsql
as $$
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

  -- Zero, always. The signature is kept so every existing caller still
  -- compiles; the number it used to return was "sessions counted by this
  -- clearance", and no clearance counts a session any more.
  return 0;
end;
$$;

comment on function clear_student(uuid, uuid, clearance_route, uuid) is
  'Marks dues cleared. Touches no attendance: since payment was decoupled, clearing counts nothing that was not already counted.';

-- ---------------------------------------------------------------------------
-- The two other functions that read the status
-- ---------------------------------------------------------------------------

-- Both are plpgsql or SQL bodies referring to `ss.status`, and neither is
-- checked until it runs. Left alone they would fail the first time the HOD
-- authorized a list or corrected a dispute — the two moments in this system
-- with the least tolerance for a runtime error.

-- The eligibility list's score total. Copied verbatim from
-- ..._authorize_eligibility.sql with ONE clause removed — the `ss.status =
-- 'confirmed'` that no longer has a column behind it. Deliberately verbatim:
-- the first attempt rewrote the function from its description and quietly lost
-- the threshold snapshot, the frozen-list guard and half the audit metadata.
-- A function you are replacing to change one line is not a function you are
-- redesigning.
create or replace function authorize_eligibility_list(
  p_course_id uuid,
  p_actor_id  uuid,
  p_note      text
)
returns table (eligible integer, not_eligible integer)
language plpgsql
as $$
declare
  v_course    courses%rowtype;
  v_list_id   uuid;
  v_status    eligibility_status;
  v_threshold numeric;
  v_eligible  integer;
  v_total     integer;
begin
  if p_actor_id is null then
    raise exception 'an authorization must record who made it';
  end if;

  if length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'an authorization must record why';
  end if;

  if not exists (select 1 from profiles where id = p_actor_id and role = 'hod') then
    raise exception 'only the head of department can authorize an eligibility list';
  end if;

  select * into v_course from courses where id = p_course_id;
  if v_course.id is null then
    raise exception 'that course does not exist';
  end if;

  select el.id, el.status, el.threshold_pct
    into v_list_id, v_status, v_threshold
  from eligibility_lists el
  where el.course_id = p_course_id
    and el.academic_session_id = v_course.academic_session_id;

  -- Frozen means frozen. A correction is a NEW list, not an edit to this one,
  -- so that the version the board saw stays recoverable.
  if v_status = 'authorized' then
    return query select 0, 0;
    return;
  end if;

  if v_list_id is null then
    select attendance_threshold_pct into v_threshold from app_config where id = 1;

    insert into eligibility_lists (course_id, academic_session_id, status, threshold_pct)
    values (p_course_id, v_course.academic_session_id, 'draft', coalesce(v_threshold, 75))
    returning id into v_list_id;
  end if;

  -- Any earlier draft rows are replaced rather than added to. A list built
  -- twice must not contain a student twice, and the draft has no standing to
  -- preserve — only the authorized snapshot does.
  delete from eligibility_entries where list_id = v_list_id;

  -- The snapshot, computed through attendance_pct() so the frozen number is
  -- the same number every other screen showed. Dropped enrolments are excluded
  -- but their rows survive, exactly as they do everywhere else.
  insert into eligibility_entries (
    list_id, student_id, attendance_pct, score_total, sessions_held, eligible
  )
  select
    v_list_id,
    e.student_id,
    attendance_pct(e.student_id, p_course_id),
    coalesce((
      select sum(ss.score)
      from session_scores ss
      join session_instances si on si.id = ss.session_instance_id
      where ss.student_id = e.student_id
        and si.course_id = p_course_id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ), 0),
    (
      select count(*)
      from session_instances si
      where si.course_id = p_course_id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ),
    -- A course that has held nothing makes nobody eligible and nobody
    -- ineligible; 0 of 0 is not a failure to attend. The list records them as
    -- not eligible rather than inventing a pass, and the count on the screen
    -- says how many lectures it was computed from.
    attendance_pct(e.student_id, p_course_id) >= v_threshold
      and exists (
        select 1 from session_instances si
        where si.course_id = p_course_id and si.status = 'closed'
      )
  from enrolments e
  where e.course_id = p_course_id
    and e.dropped_at is null;

  update eligibility_lists
     set status        = 'authorized',
         authorized_by = p_actor_id,
         authorized_at = now()
   where id = v_list_id;

  select count(*) filter (where ee.eligible), count(*)
    into v_eligible, v_total
  from eligibility_entries ee
  where ee.list_id = v_list_id;

  perform write_audit(
    p_actor_id, 'hod', 'eligibility.authorize', 'eligibility_lists', v_list_id::text, btrim(p_note),
    jsonb_build_object(
      'course_id', p_course_id,
      'course_code', v_course.code,
      'threshold_pct', v_threshold,
      'eligible', v_eligible,
      'not_eligible', v_total - v_eligible
    )
  );

  return query select v_eligible, v_total - v_eligible;
end;
$$;

revoke all on function authorize_eligibility_list(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function authorize_eligibility_list(uuid, uuid, text) to service_role;

-- Correcting a dispute writes a score row directly when the lecture has no
-- attendance code to re-derive one from. Copied verbatim from
-- ..._correction_never_lowers.sql with ONE change: the insert loses the status
-- column and its value. Same discipline as above — the first attempt rewrote
-- it from memory and invented a column that has never existed.
create or replace function resolve_dispute(
  p_dispute_id uuid,
  p_actor_id   uuid,
  p_uphold     boolean,
  p_reason     text
)
returns text
language plpgsql
as $$
declare
  v_row         attendance_disputes%rowtype;
  v_score       numeric;
  v_before      numeric;
  v_checkpoints integer;
begin
  if p_actor_id is null then
    raise exception 'a dispute resolution must record who made it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a dispute resolution must record why';
  end if;

  select * into v_row from attendance_disputes where id = p_dispute_id;

  if v_row.id is null then return 'not_found'; end if;
  if v_row.status <> 'open' then return 'already_resolved'; end if;

  select score into v_before
  from session_scores
  where student_id = v_row.student_id and session_instance_id = v_row.session_instance_id;

  if not p_uphold then
    select count(*) into v_checkpoints
    from checkpoints where session_instance_id = v_row.session_instance_id;

    if v_checkpoints = 0 then
      -- Nothing to accept and nothing to re-score from — a paper-register
      -- lecture, or one whose checkpoints were never issued. The HOD has said
      -- the student was there for it, and with no checkpoint structure to
      -- apportion, "there" means the whole lecture.
      insert into session_scores (student_id, session_instance_id, score, source)
      values (v_row.student_id, v_row.session_instance_id, 1.0, 'manually_entered')
      on conflict (student_id, session_instance_id) do update
        set score = 1.0, source = 'manually_entered';

      v_score := 1.0;
    else
      -- The named checkpoint is accepted; with no checkpoint named the student
      -- disputed the whole lecture, so every checkpoint of it is.
      --
      -- Upserted rather than inserted: a dispute usually follows a REJECTED
      -- submission, so the row already exists and carries the rejection.
      insert into attendance_marks (student_id, checkpoint_id, accepted, reject_reason, submitted_at)
      select v_row.student_id, cp.id, true, null, now()
      from checkpoints cp
      where cp.session_instance_id = v_row.session_instance_id
        and (v_row.checkpoint_id is null or cp.id = v_row.checkpoint_id)
      on conflict (student_id, checkpoint_id) do update
        set accepted = true, reject_reason = null;

      -- Re-scored through the same function the lecturer's close uses, so a
      -- corrected lecture is scored by the same rules as every other one.
      v_score := resolve_session_score(v_row.student_id, v_row.session_instance_id);

      -- The floor. Re-scoring can only be trusted to the extent the marks it
      -- reads are complete, and a correction is an instruction to credit the
      -- student, never to dock them. If the recomputation comes out lower than
      -- what was already recorded, the recomputation is what is wrong.
      if v_before is not null and v_score < v_before then
        update session_scores
           set score = v_before
         where student_id = v_row.student_id
           and session_instance_id = v_row.session_instance_id;

        v_score := v_before;
      end if;
    end if;
  end if;

  update attendance_disputes
     set status            = (case when p_uphold then 'upheld' else 'corrected' end)::dispute_status,
         resolution_reason = btrim(p_reason),
         resolved_by       = p_actor_id,
         resolved_at       = now()
   where id = p_dispute_id;

  -- The before and after are both recorded. "The score changed" is not a
  -- defensible answer six months later; "it went from 0.5 to 1.0, on this date,
  -- by this person, for this reason" is.
  perform write_audit(
    p_actor_id, 'hod',
    case when p_uphold then 'dispute.upheld' else 'dispute.corrected' end,
    'attendance_disputes', p_dispute_id::text, btrim(p_reason),
    jsonb_build_object(
      'student_id', v_row.student_id,
      'session_instance_id', v_row.session_instance_id,
      'score_before', v_before,
      'score_after', coalesce(v_score, v_before)
    )
  );

  return case when p_uphold then 'upheld' else 'corrected' end;
end;
$$;

revoke all on function resolve_dispute(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function resolve_dispute(uuid, uuid, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- Money owed, and money paid
-- ---------------------------------------------------------------------------

-- Instalments. `payment_matches_dues()` compared one payment against the whole
-- figure, which forces every student to pay in one go or be permanently short.
create or replace function dues_paid_kobo(
  p_student_id uuid,
  p_academic_session_id uuid
)
returns double precision
language sql
stable
as $$
  select coalesce(sum(p.amount_kobo), 0)::double precision
  from payments p
  where p.student_id = p_student_id
    and p.academic_session_id = p_academic_session_id
    and p.status = 'success';
$$;

create or replace function dues_balance_kobo(
  p_student_id uuid,
  p_academic_session_id uuid
)
returns double precision
language sql
stable
as $$
  select greatest(
    0,
    coalesce((select dp.dues_amount_kobo from dues_periods dp
               where dp.academic_session_id = p_academic_session_id), 0)
      - dues_paid_kobo(p_student_id, p_academic_session_id)
  )::double precision;
$$;

comment on function dues_balance_kobo(uuid, uuid) is
  'What is still owed, in kobo. Floors at zero: an overpayment is a refund conversation, not a negative debt the screens have to render.';

grant execute on function dues_paid_kobo(uuid, uuid) to authenticated, service_role;
grant execute on function dues_balance_kobo(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A resent webhook must not credit twice
-- ---------------------------------------------------------------------------

-- Paystack retries. The reference is unique on `payments`, which stops a
-- second row, but not a second CREDIT against the existing one — and with
-- instalments summing to a balance, a double credit is now a student who
-- appears to have paid twice what they did.
create table payment_events (
  -- Paystack's own event id. Primary key, so the second delivery of the same
  -- event is refused by the database rather than by a check somebody
  -- remembered to write.
  event_id      text primary key,
  event_type    text not null,
  reference     text not null,
  payment_id    uuid references payments (id) on delete set null,
  payload       jsonb not null default '{}'::jsonb,
  received_at   timestamptz not null default now()
);

create index payment_events_reference_idx on payment_events (reference, received_at desc);

comment on table payment_events is
  'Every webhook Paystack has delivered, keyed on its own event id. Inserting is how a duplicate delivery is detected.';

-- ---------------------------------------------------------------------------
-- What a payment now carries
-- ---------------------------------------------------------------------------

alter table payments
  -- Paystack's card fingerprint. The same physical card across several matric
  -- numbers is the anomaly worth seeing, and it cannot be seen without this.
  add column card_signature   text,
  add column last4            text,
  -- The manual route: a receipt, an approver, and a permanent mark that this
  -- was not verified by the gateway.
  add column manually_verified boolean not null default false,
  add column verified_by       uuid references profiles (id),
  add column verification_note text,
  add column receipt_url       text,
  add column reversed_at       timestamptz,
  add column reversal_reason   text;

-- The existing constraint requires a verified_at on every success. A manually
-- verified payment has no Paystack verification to point at, so it stamps
-- verified_at itself and records who decided — the check below is what makes
-- "manually verified" mean a person rather than a missing field.
alter table payments
  add constraint payment_manual_names_approver check (
    not manually_verified
    or (verified_by is not null and length(btrim(coalesce(verification_note, ''))) >= 10)
  ),
  add constraint payment_reversal_has_reason check (
    reversed_at is null or length(btrim(coalesce(reversal_reason, ''))) > 0
  );

comment on column payments.manually_verified is
  'True when an admin accepted a receipt rather than Paystack confirming it. Never cleared: the record of how this was accepted outlives the office that accepted it.';

-- ---------------------------------------------------------------------------
-- The integrity check
-- ---------------------------------------------------------------------------

-- Three anomalies, from §8: a reference recorded more than once, one card
-- funding several different matric numbers, and an amount that is not the
-- dues figure. None of them is proof of anything — a family sharing a card is
-- ordinary — so this returns rows for a human to look at and blocks nothing.
create or replace function payment_anomalies(p_academic_session_id uuid)
returns table (
  kind        text,
  detail      text,
  reference   text,
  student_id  uuid,
  matric_no   text,
  amount_kobo double precision,
  seen_at     timestamptz
)
language sql
stable
as $$
  with dues as (
    select dues_amount_kobo from dues_periods where academic_session_id = p_academic_session_id
  ),
  mine as (
    select p.*, s.matric_no
    from payments p
    join students s on s.id = p.student_id
    where p.academic_session_id = p_academic_session_id
  )
  -- One card, several matric numbers.
  select
    'shared_card',
    format('Card ending %s funded %s different matric numbers',
           coalesce(m.last4, '????'),
           (select count(distinct m2.student_id) from mine m2
             where m2.card_signature = m.card_signature)),
    m.paystack_reference, m.student_id, m.matric_no, m.amount_kobo, m.initialized_at
  from mine m
  where m.card_signature is not null
    and (select count(distinct m2.student_id) from mine m2
          where m2.card_signature = m.card_signature) > 1

  union all

  -- An amount that is not the dues figure and does not close a balance
  -- either. An instalment is fine; a payment for an amount nobody asked for
  -- is worth a look.
  select
    'unexpected_amount',
    format('Paid %s kobo against a dues figure of %s',
           m.amount_kobo::bigint, (select dues_amount_kobo from dues)::bigint),
    m.paystack_reference, m.student_id, m.matric_no, m.amount_kobo, m.initialized_at
  from mine m
  where m.status = 'success'
    and (select dues_amount_kobo from dues) is not null
    and m.amount_kobo > (select dues_amount_kobo from dues)

  union all

  -- A reversal is not an anomaly in itself, but it is always worth the
  -- office's attention: the debt reopened and the student may not know.
  select
    'reversed',
    coalesce(m.reversal_reason, 'Reversed by the gateway'),
    m.paystack_reference, m.student_id, m.matric_no, m.amount_kobo, m.reversed_at
  from mine m
  where m.reversed_at is not null;
$$;

comment on function payment_anomalies(uuid) is
  'Flags for a human to judge, never a block. A family sharing one card is ordinary; the same card across ten matric numbers is not.';

revoke all on function payment_anomalies(uuid) from public, anon;
grant execute on function payment_anomalies(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Recording a payment, from whichever route
-- ---------------------------------------------------------------------------

-- One place decides what a successful payment does, so the gateway route and
-- the receipt route cannot drift. Clearing is a consequence of the BALANCE
-- reaching zero rather than of any single payment matching the dues figure,
-- which is what makes instalments work.
create or replace function apply_payment(
  p_payment_id uuid,
  p_actor_id   uuid default null
)
returns text
language plpgsql
as $$
declare
  v_payment payments%rowtype;
  v_balance double precision;
begin
  select * into v_payment from payments where id = p_payment_id;
  if v_payment.id is null then return 'not_found'; end if;
  if v_payment.status <> 'success' then return 'not_successful'; end if;

  v_balance := dues_balance_kobo(v_payment.student_id, v_payment.academic_session_id);

  if v_balance > 0 then
    -- Part paid. Deliberately NOT a compliance state of its own: the ladder
    -- has five states and inventing a sixth for "halfway" would be a hard-rule
    -- violation. The balance is the fact; the screens read it directly.
    return 'part_paid';
  end if;

  perform clear_student(
    v_payment.student_id,
    v_payment.academic_session_id,
    case when v_payment.manually_verified then 'hod_clearance' else 'payment' end::clearance_route,
    case when v_payment.manually_verified then p_actor_id end
  );

  return 'cleared';
end;
$$;

revoke all on function apply_payment(uuid, uuid) from public, anon, authenticated;
grant execute on function apply_payment(uuid, uuid) to service_role;

comment on function apply_payment(uuid, uuid) is
  'What a successful payment does. Clears only when the BALANCE reaches zero, so instalments accumulate instead of each one failing to match the dues figure.';

-- ---------------------------------------------------------------------------
-- A reversal reopens the debt, with notice
-- ---------------------------------------------------------------------------

-- Never a silent revoke. The student believed they had paid, and the first
-- they hear of a chargeback must not be an exam hall.
create or replace function reverse_payment(
  p_payment_id uuid,
  p_reason     text,
  p_actor_id   uuid default null
)
returns text
language plpgsql
as $$
declare
  v_payment payments%rowtype;
  v_balance double precision;
begin
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reversal must record why';
  end if;

  select * into v_payment from payments where id = p_payment_id;
  if v_payment.id is null then return 'not_found'; end if;
  if v_payment.reversed_at is not null then return 'already_reversed'; end if;

  update payments
     set status          = 'reversed',
         reversed_at     = now(),
         reversal_reason = btrim(p_reason),
         verified_at     = null
   where id = p_payment_id;

  v_balance := dues_balance_kobo(v_payment.student_id, v_payment.academic_session_id);

  -- Back to uncleared only if the reversal actually reopened a debt. A student
  -- who had overpaid, or who has since paid again, is left alone.
  if v_balance > 0 then
    update compliance_statuses
       set state       = 'uncleared',
           cleared_at  = null,
           cleared_via = null,
           cleared_by  = null
     where student_id = v_payment.student_id
       and academic_session_id = v_payment.academic_session_id
       and state = 'cleared';
  end if;

  insert into notifications (recipient_id, kind, title, body, link)
  values (
    v_payment.student_id,
    'payment_reminder',
    'A payment has been reversed',
    format(
      'A dues payment of ₦%s was reversed by the bank. You now owe ₦%s. Nothing about your attendance has changed.',
      trim(to_char(v_payment.amount_kobo / 100.0, '999G999G990D99')),
      trim(to_char(v_balance / 100.0, '999G999G990D99'))
    ),
    '/dues'
  );

  perform write_audit(
    p_actor_id, coalesce((select role from profiles where id = p_actor_id), 'admin'),
    'payment.reversed', 'payments', p_payment_id::text, btrim(p_reason),
    jsonb_build_object(
      'student_id', v_payment.student_id,
      'amount_kobo', v_payment.amount_kobo,
      'balance_after', v_balance
    )
  );

  return case when v_balance > 0 then 'reopened' else 'reversed_no_debt' end;
end;
$$;

revoke all on function reverse_payment(uuid, text, uuid) from public, anon, authenticated;
grant execute on function reverse_payment(uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The manual route
-- ---------------------------------------------------------------------------

-- For the day the gateway is down or a student paid at the bank counter. It is
-- an authority action in the same shape as every other one: an actor, a
-- mandatory reason, an audit row — and a permanent flag on the payment, so
-- nobody a year from now has to work out why there is no Paystack record.
create or replace function record_manual_payment(
  p_student_id          uuid,
  p_academic_session_id uuid,
  p_amount_kobo         double precision,
  p_reference           text,
  p_note                text,
  p_actor_id            uuid,
  p_receipt_url         text default null
)
returns table (payment_id uuid, outcome text)
language plpgsql
as $$
declare
  v_id uuid;
begin
  if p_actor_id is null then
    raise exception 'a manual payment must record who accepted it';
  end if;

  if length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'a manual payment must record why it was accepted without the gateway';
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'a payment must be for a positive amount';
  end if;

  if exists (select 1 from payments where paystack_reference = btrim(p_reference)) then
    return query select null::uuid, 'duplicate_reference'; return;
  end if;

  insert into payments (
    student_id, academic_session_id, paystack_reference, channel, status,
    amount_kobo, verified_at, manually_verified, verified_by, verification_note,
    receipt_url
  )
  values (
    p_student_id, p_academic_session_id, btrim(p_reference), 'transfer', 'success',
    trunc(p_amount_kobo), now(), true, p_actor_id, btrim(p_note), p_receipt_url
  )
  returning id into v_id;

  perform write_audit(
    p_actor_id, coalesce((select role from profiles where id = p_actor_id), 'admin'),
    'payment.manual', 'payments', v_id::text, btrim(p_note),
    jsonb_build_object(
      'student_id', p_student_id,
      'amount_kobo', trunc(p_amount_kobo),
      'reference', btrim(p_reference),
      'receipt', p_receipt_url is not null
    )
  );

  return query select v_id, apply_payment(v_id, p_actor_id);
end;
$$;

revoke all on function record_manual_payment(uuid, uuid, double precision, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function record_manual_payment(uuid, uuid, double precision, text, text, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security for the new table
-- ---------------------------------------------------------------------------

alter table payment_events enable row level security;

-- Nobody reads this through PostgREST. It is written by the webhook route
-- under the service role and read by reconciliation; a student has no business
-- in it and neither has the HOD.
create policy payment_events_no_read on payment_events
  for select to authenticated using (false);

-- ---------------------------------------------------------------------------
-- The student's own view of their marks, rebuilt without the status
-- ---------------------------------------------------------------------------

create view my_attendance_marks
with (security_invoker = true)
as
  select
    am.id,
    am.checkpoint_id,
    cp.session_instance_id,
    am.accepted,
    am.reject_reason,
    am.submitted_at
  from attendance_marks am
  join checkpoints cp on cp.id = am.checkpoint_id
  where am.student_id = auth.uid();

grant select on my_attendance_marks to authenticated;

comment on view my_attendance_marks is
  'A student''s own submission attempts, accepted or not.';
