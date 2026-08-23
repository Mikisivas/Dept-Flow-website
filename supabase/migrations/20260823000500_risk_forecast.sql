-- Dept-Flow — the forecast, and what it is allowed to do about it
--
-- "This is the core of Dept-Flow: a FORECAST, not a scoreboard. The model asks
-- 'where is this student headed?' rather than just reporting 'where are they
-- now?' — that's what makes it a warning system instead of a passive tracker."
--
-- The existing signal is a scoreboard wearing a forecast's name. It computes
-- the student's attendance rate so far and stores it as `predicted_pct`, which
-- is not a prediction — it is the same number the meter already shows, copied
-- into another table. A student who attended ten lectures and then stopped
-- reads 76% on both, and 76% is above the line, so nothing warns anybody.
--
-- WHAT REPLACES IT
--
-- Two numbers, computed differently and used for different things:
--
--   trend        the least-squares slope of attendance against lecture
--                number. Negative means falling away. This EXPLAINS the
--                warning — it is why a student is being told something — and
--                it decides which of the two patterns they are shown.
--   projected    where they finish, from a blend of their recent rate and
--                their overall rate, applied to the lectures still to come.
--
-- The projection is deliberately NOT the slope extrapolated forward, and the
-- first version of this made that mistake. A binary series' OLS slope is very
-- noisy: a student who attended nine of ten lectures has a slope steep enough
-- to project them to 54% over another seventeen, purely because of where in
-- the sequence the one absence fell. Warning that student is worse than
-- useless — an alert system that cries wolf in week six is one nobody reads in
-- week eleven, and by then it is the only thing that could have helped.
--
-- So the forward estimate is the average of the last five lectures and the
-- whole term. The recent window says what they are doing now; the overall rate
-- says what they do in general; neither deserves to dominate, and the truth is
-- between them. It is responsive enough to catch Chidera — ten straight, then
-- three missed — and steady enough not to panic over one bad morning.
--
-- It is a regression. It is not scikit-learn, and the seam for scikit-learn is
-- unchanged and still real: everything here writes `risk_predictions`, every
-- reader is indifferent to what produced the row, and the FastAPI service in
-- the stack can replace this function without touching a screen. What has not
-- changed since that argument was first written is that there is no history to
-- train on — one academic session, and a classifier fitted to it would be the
-- training set memorised. What HAS changed is that a rule can now be wrong in
-- a way that matters, so the rule had to become one that actually forecasts.
--
-- WHY A STRAIGHT LINE
--
-- Because it can be explained to the student it is about. "You have missed
-- three of the last four, and at that rate you finish at 61%" is a sentence a
-- student can act on and argue with. A gradient-boosted answer to the same
-- question is a number they have to take on trust, and this system's whole
-- claim on a student's attention is that it tells them WHY.

-- ---------------------------------------------------------------------------
-- Tiers
-- ---------------------------------------------------------------------------

-- §5.2, exactly. The boundaries are not arbitrary: 75% is the eligibility
-- rule, so Watch is the band where a student is on course to land ON the line
-- with no buffer at all — one illness from ineligible. Safe means there is
-- room for something to go wrong.
create type risk_tier as enum ('safe', 'watch', 'critical');

alter table risk_predictions
  add column tier             risk_tier,
  -- Slope of the fit, in percentage points per lecture. Kept because it is
  -- what distinguishes a student who has always been at 70% from one who was
  -- at 95% and is falling — the same projection, two different conversations.
  add column trend            numeric(6,3),
  add column lectures_held    integer,
  add column lectures_expected integer,
  -- The two numbers the alert copy is made of. Computed here so the sentence
  -- on the screen, the sentence in the WhatsApp message and the sentence in
  -- the SMS are the same sentence.
  add column must_attend      integer,
  add column can_still_miss   integer;

comment on column risk_predictions.predicted_pct is
  'Projected end-of-semester attendance, from the trend. NOT the current percentage — that is what attendance_pct() is for.';

comment on column risk_predictions.trend is
  'Percentage points per lecture. Negative is a student falling away, which is the case this whole system exists to catch early.';

-- ---------------------------------------------------------------------------
-- How many lectures a course still has to hold
-- ---------------------------------------------------------------------------

-- A projection needs a denominator, and "lectures held so far" is the wrong
-- one — that is what makes a scoreboard. What is needed is how many the course
-- will have held by the end, which comes from the timetable: a weekly slot
-- times the weeks left in the session.
create or replace function lectures_remaining(p_course_id uuid)
returns integer
language sql
stable
as $$
  with course_session as (
    select a.ends_on
    from courses c
    join academic_sessions a on a.id = c.academic_session_id
    where c.id = p_course_id
  ),
  slots as (
    select count(*)::numeric as per_week
    from timetable_entries t
    where t.course_id = p_course_id
  )
  select greatest(
    0,
    floor(
      slots.per_week
      * greatest(0, (course_session.ends_on - current_date))::numeric / 7.0
    )
  )::integer
  from course_session, slots;
$$;

comment on function lectures_remaining(uuid) is
  'Weekly slots times the weeks left in the session. A course with no timetable row returns 0, which makes its projection its current rate — the honest answer when nothing says another lecture is coming.';

grant execute on function lectures_remaining(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The forecast
-- ---------------------------------------------------------------------------

create or replace function compute_risk_predictions()
returns integer
language plpgsql
as $$
declare
  v_written   integer;
  v_threshold numeric;
begin
  select attendance_threshold_pct into v_threshold from app_config where id = 1;
  v_threshold := coalesce(v_threshold, 75);

  -- Wholesale rather than incremental. A prediction is only ever a statement
  -- about the present, and a stale row for a student who has since turned
  -- things around is worse than no row.
  delete from risk_predictions;

  with
  -- Every closed lecture the student was enrolled for, numbered in the order
  -- they were held. The number is the x-axis of the fit.
  ordered as (
    select
      e.student_id,
      e.course_id,
      row_number() over (partition by e.student_id, e.course_id order by si.held_on) as n,
      -- How far this lecture is from the most recent one, so "the last five"
      -- can be expressed without a window function inside a FILTER, which
      -- Postgres does not allow.
      row_number() over (
        partition by e.student_id, e.course_id order by si.held_on desc
      ) as from_end,
      coalesce(ss.score, 0)::numeric as attended
    from enrolments e
    join session_instances si
      on si.course_id = e.course_id
     and si.status = 'closed'
     and si.held_on >= e.enrolled_on
     and (e.dropped_at is null or si.held_on < e.dropped_at::date)
    left join session_scores ss
      on ss.session_instance_id = si.id
     and ss.student_id = e.student_id
    where e.dropped_at is null
  ),
  -- Ordinary least squares, by its closed form. slope = Sxy / Sxx, where the
  -- S terms are the deviations from the means. Postgres has regr_slope() for
  -- exactly this and it is used rather than spelled out, because a hand-rolled
  -- covariance is a place to put a bug that nobody would ever see.
  fitted as (
    select
      student_id,
      course_id,
      count(*)::integer                       as held,
      sum(attended)                           as attended_total,
      avg(attended)                           as rate,
      -- Null when there is one row or the outcomes are constant — a student
      -- who has attended everything has no trend, and inventing one for them
      -- would be noise.
      --
      -- Cast at the source. regr_slope() returns double precision, and one
      -- double anywhere downstream turns the whole expression into a double —
      -- at which point round(x, 2) does not exist and the nightly job fails on
      -- a function signature rather than on anything to do with risk.
      regr_slope(attended, n)::numeric        as slope,
      max(n)                                  as last_n,
      -- The last five lectures, which is what "recently" means here. Five is
      -- roughly a month of a weekly course: long enough that one absence does
      -- not halve it, short enough to move within a term.
      avg(attended) filter (where from_end <= 5)  as recent_rate
    from ordered
    group by student_id, course_id
  ),
  projected as (
    select
      f.student_id,
      f.course_id,
      f.held,
      f.attended_total,
      f.rate,
      coalesce(f.slope, 0) as slope,
      lectures_remaining(f.course_id) as remaining,
      -- The forward estimate: half what they have been doing lately, half what
      -- they have done all term. See the header for why this is not the slope
      -- extrapolated — in short, because doing that turns one missed lecture
      -- in ten into a projected failure.
      (coalesce(f.recent_rate, f.rate) + f.rate) / 2.0 as forward_rate
    from fitted f
    -- "From around week 5–6 onward." Below that there is nothing to project
    -- from: one missed lecture out of three is a rate that says almost
    -- nothing, and a warning system that fires in week two is one nobody reads
    -- in week nine.
    where f.held >= 5
  ),
  final as (
    select
      student_id,
      course_id,
      held,
      attended_total,
      rate,
      slope,
      remaining,
      held + remaining as expected_total,
      round(
        case
          when held + remaining = 0 then 0
          else (attended_total + remaining * forward_rate) / (held + remaining) * 100
        end, 2
      ) as predicted_pct
    from projected
  )
  insert into risk_predictions (
    student_id, course_id, predicted_pct, pattern, tier, trend,
    lectures_held, lectures_expected, must_attend, can_still_miss
  )
  select
    student_id,
    course_id,
    -- Bounded, because the arithmetic above can round a hair past 100.
    least(100, greatest(0, predicted_pct)),
    case
      when predicted_pct >= v_threshold then null
      -- Two ways to be heading for trouble, and they need different
      -- conversations.
      --
      -- Disengagement covers both students who are not there: the one whose
      -- trend is falling — was fine, stopped coming, something changed and
      -- asking what is the useful response — and the one who never started at
      -- all. A flat line at zero is not "partial" attendance in any sense a
      -- person would recognise, and labelling it that way would send the wrong
      -- conversation to the student who most needs the right one.
      when slope < -0.01 then 'disengagement'::risk_pattern
      when rate < 0.4 then 'disengagement'::risk_pattern
      -- What is left: turning up sometimes, steadily, and not enough.
      else 'partial_attendance'::risk_pattern
    end,
    case
      when predicted_pct < v_threshold then 'critical'::risk_tier
      when predicted_pct < 80 then 'watch'::risk_tier
      else 'safe'::risk_tier
    end,
    round(slope * 100, 3),
    held,
    expected_total,
    -- "The exact number of classes the student must still attend." Of the
    -- lectures still to come, how many are needed to finish at the threshold.
    -- Capped at what remains: a student who cannot reach it however hard they
    -- try must be told that, not handed an impossible number.
    least(
      remaining,
      greatest(0, ceil((v_threshold / 100.0) * (held + remaining) - attended_total))::integer
    ),
    -- "…or can still miss." The other half of the same sentence, and the half
    -- a student on track actually reads.
    greatest(
      0,
      remaining - greatest(0, ceil((v_threshold / 100.0) * (held + remaining) - attended_total))::integer
    )
  from final;

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

comment on function compute_risk_predictions() is
  'Least-squares fit over the lectures held, projected to the end of the semester. Advisory only — attendance_pct() decides eligibility and never consults this.';

revoke all on function compute_risk_predictions() from public, anon, authenticated;
grant execute on function compute_risk_predictions() to service_role;

-- ---------------------------------------------------------------------------
-- The what-if calculator (§5.5)
-- ---------------------------------------------------------------------------

-- "An interactive what-if calculator on the student dashboard shows the effect
-- of missing upcoming classes before it happens."
--
-- In the database rather than in the browser, and it matters: the arithmetic
-- is the eligibility rule, and a second copy of the eligibility rule written
-- in TypeScript is a second copy that will one day disagree with the first.
-- The screen asks and renders; it does not compute.
create or replace function attendance_what_if(
  p_student_id uuid,
  p_course_id  uuid,
  p_miss_next  integer
)
returns table (
  resulting_pct  numeric,
  still_eligible boolean,
  must_attend    integer,
  remaining      integer
)
language sql
stable
as $$
  with base as (
    select
      coalesce((
        select sum(ss.score)
        from session_scores ss
        join session_instances si on si.id = ss.session_instance_id
        join enrolments e on e.student_id = ss.student_id and e.course_id = si.course_id
        where ss.student_id = p_student_id
          and si.course_id = p_course_id
          and si.status = 'closed'
          and si.held_on >= e.enrolled_on
      ), 0)::numeric as attended,
      coalesce((
        select count(*)
        from session_instances si
        join enrolments e on e.course_id = si.course_id and e.student_id = p_student_id
        where si.course_id = p_course_id
          and si.status = 'closed'
          and si.held_on >= e.enrolled_on
      ), 0)::numeric as held,
      lectures_remaining(p_course_id)::numeric as remaining,
      coalesce((select attendance_threshold_pct from app_config where id = 1), 75) as threshold
  ),
  answered as (
    select
      *,
      -- Missing more than there are left is not a scenario, it is a typo.
      least(greatest(coalesce(p_miss_next, 0), 0), remaining) as missed
    from base
  )
  select
    case
      when held + remaining = 0 then 0::numeric
      else round((attended + (remaining - missed)) / (held + remaining) * 100, 2)
    end,
    case
      when held + remaining = 0 then true
      else (attended + (remaining - missed)) / (held + remaining) * 100 >= threshold
    end,
    least(
      remaining,
      greatest(0, ceil((threshold / 100.0) * (held + remaining) - attended))
    )::integer,
    remaining::integer
  from answered;
$$;

comment on function attendance_what_if(uuid, uuid, integer) is
  'What missing N of the remaining lectures would do to this student on this course. The eligibility arithmetic lives here so the calculator and the permit cannot disagree.';

revoke all on function attendance_what_if(uuid, uuid, integer) from public, anon;
grant execute on function attendance_what_if(uuid, uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Turning a forecast into a warning
-- ---------------------------------------------------------------------------

-- §5.3 and §5.4 together: the channels scale with the tier, and the copy names
-- the course and the exact number of lectures. "Your attendance is low" is the
-- message this function exists to never send.
--
-- Warnings are sent once per tier per course. A student who is Critical for
-- six weeks gets one Critical warning, not forty-two — and if they climb to
-- Watch and fall back, they get a new one, because that is genuinely new
-- information.
create table risk_alerts_sent (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references students (id) on delete cascade,
  course_id    uuid not null references courses (id) on delete cascade,
  tier         risk_tier not null,
  predicted_pct numeric(5,2) not null,
  notification_id uuid references notifications (id) on delete set null,
  sent_at      timestamptz not null default now()
);

create index risk_alerts_sent_lookup_idx
  on risk_alerts_sent (student_id, course_id, sent_at desc);

alter table risk_alerts_sent enable row level security;

create policy risk_alerts_sent_self_read on risk_alerts_sent
  for select to authenticated using (student_id = auth.uid());

create policy risk_alerts_sent_staff_read on risk_alerts_sent
  for select to authenticated using (is_hod());

comment on table risk_alerts_sent is
  'One warning per tier per course. A student who is Critical for six weeks gets one Critical warning, not forty-two.';

create or replace function send_risk_alerts()
returns integer
language plpgsql
as $$
declare
  v_row      record;
  v_sent     integer := 0;
  v_note     uuid;
  v_title    text;
  v_body     text;
  v_channels notification_channel[];
begin
  for v_row in
    select
      rp.*,
      c.code as course_code,
      (select tier from risk_alerts_sent prev
        where prev.student_id = rp.student_id
          and prev.course_id = rp.course_id
        order by prev.sent_at desc
        limit 1) as last_tier
    from risk_predictions rp
    join courses c on c.id = rp.course_id
    join students s on s.id = rp.student_id
    where rp.tier in ('watch', 'critical')
      and s.status <> 'deactivated'
  loop
    -- Already told, at this tier, and nothing has changed. Silence is the
    -- correct output: an alert that repeats every night is an alert a student
    -- mutes, and a muted channel is one that cannot warn them in week eleven.
    if v_row.last_tier is not distinct from v_row.tier then
      continue;
    end if;

    if v_row.tier = 'critical' then
      -- §5.3: in-app, Web Push, WhatsApp. SMS is held back for the final
      -- warning rather than spent on the first Critical — a student who gets a
      -- text in week six has nothing left to escalate to in week eleven.
      v_channels := array['in_app', 'web_push', 'whatsapp']::notification_channel[];

      -- The final, most severe warning: there is no slack left at all — every
      -- remaining lecture is needed, so the next one missed ends it. This is
      -- the one that earns an SMS, because SMS needs no data connection and
      -- because there is nothing after it to escalate to.
      if v_row.can_still_miss = 0 then
        v_channels := v_channels || 'sms'::notification_channel;
      end if;

      v_title := format('%s: you must attend every remaining lecture', v_row.course_code);

      if v_row.can_still_miss = 0 then
        v_body := format(
          '%s is projected to finish at %s%%. You have %s lectures left and need every one of them to reach 75%%. Missing one more makes you ineligible for the exam.',
          v_row.course_code,
          trim(to_char(v_row.predicted_pct, '990D9')),
          v_row.lectures_expected - v_row.lectures_held
        );
      else
        v_title := format('%s: you are on course to miss the 75%% mark', v_row.course_code);
        v_body := format(
          '%s is projected to finish at %s%%. Attend %s of the %s lectures left and you reach 75%%. You can miss %s.',
          v_row.course_code,
          trim(to_char(v_row.predicted_pct, '990D9')),
          v_row.must_attend,
          v_row.lectures_expected - v_row.lectures_held,
          v_row.can_still_miss
        );
      end if;
    else
      -- Watch: in-app and Web Push. No WhatsApp — a student who is on course
      -- to land exactly on the line needs to know, and does not need a
      -- message on the channel reserved for the students who are failing.
      v_channels := array['in_app', 'web_push']::notification_channel[];
      v_title := format('%s: no buffer left', v_row.course_code);
      v_body := format(
        '%s is projected to finish at %s%%, which is just above the 75%% line. You can miss %s more lectures — after that there is no room left.',
        v_row.course_code,
        trim(to_char(v_row.predicted_pct, '990D9')),
        v_row.can_still_miss
      );
    end if;

    v_note := queue_notification(
      v_row.student_id,
      'attendance_warning',
      v_title,
      v_body,
      '/courses/' || replace(v_row.course_code, ' ', '-'),
      v_channels
    );

    insert into risk_alerts_sent (student_id, course_id, tier, predicted_pct, notification_id)
    values (v_row.student_id, v_row.course_id, v_row.tier, v_row.predicted_pct, v_note);

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

revoke all on function send_risk_alerts() from public, anon, authenticated;
grant execute on function send_risk_alerts() to service_role;

comment on function send_risk_alerts() is
  'Turns forecasts into warnings, once per tier per course, on the channels that tier earns. The copy names the course and the exact number of lectures — "your attendance is low" is what this exists to never send.';

-- ---------------------------------------------------------------------------
-- Folded into the nightly job
-- ---------------------------------------------------------------------------

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

  -- Advisory, and deliberately last: a failure to refresh predictions must not
  -- stop the compliance ladder, which is the part with consequences.
  perform compute_risk_predictions();

  -- And the warnings, which are the point of the forecast. Also last, and for
  -- the same reason — but note that a failure HERE is a student not warned,
  -- which is the failure this system was rebuilt to avoid. It is loud rather
  -- than swallowed.
  perform send_risk_alerts();

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
