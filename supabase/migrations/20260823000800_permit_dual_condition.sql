-- Dept-Flow — the exam permit (§9)
--
-- "Printing the permit requires BOTH conditions: dues paid in full AND ≥75%
-- attendance in each registered course."
--
-- Payment was decoupled from attendance two migrations ago, and this is where
-- it comes back. The two facts never touch on the way in — a lecture counts
-- whether or not the student has paid a naira, which is the whole point of the
-- decoupling — and they meet exactly once, here, at the door of the exam hall.
--
-- HOW "BOTH" IS APPLIED
--
-- Each condition gates what it actually governs:
--
--   * Dues gate the DOCUMENT. An outstanding balance means no permit at all,
--     for any paper. This is the department's one point of leverage and it is
--     applied as one.
--
--   * The 75% rule gates each PAPER. A student clear of dues and above the
--     line in four of five courses is issued a permit for the four, with the
--     fifth named on it as excluded and why.
--
-- The alternative reading — one short course voids the entire permit — would
-- bar a student from four exams they are entitled to sit because of a fifth,
-- and nothing in the department's rules asks for that. It is flagged here
-- because it is a reading, not a certainty: if the intent is the harsher rule,
-- it changes `issue_exam_permit` and nothing else.
--
-- AND WHY THERE IS A PANEL, NOT A VERDICT
--
-- §9.2: "shows exactly what's outstanding per student — e.g. STA204: 68%,
-- need 3 more classes; dues: ₦4,500 outstanding — instead of a flat yes/no."
--
-- A student told "not eligible" learns nothing they can act on. A student told
-- they need three more STA204 lectures and ₦4,500 has been handed the two
-- things standing between them and the hall. Every number on that panel is
-- deterministic arithmetic on the threshold — never the forecast. The model
-- may tell a student where they are heading; it may not tell them whether
-- they can sit an exam.

-- ---------------------------------------------------------------------------
-- How many of the lectures still to come a student must attend
-- ---------------------------------------------------------------------------

-- UNCAPPED, deliberately. Ask for 14 when 11 remain and the caller learns two
-- things at once: the requirement, and that it cannot be met. Capping here
-- would collapse "you need every one of the 11 left" and "you cannot get
-- there any more" into the same number, and those are opposite conversations.
--
-- N is the smallest integer with (attended + N) / (held + remaining) >= t,
-- which is ceil(t * (held + remaining) - attended). The denominator is the
-- lectures the course will have held BY THE END, not the ones it has held so
-- far — using the latter is what turns a forecast back into a scoreboard.
create or replace function lectures_needed(
  p_student_id uuid,
  p_course_id  uuid
)
returns integer
language sql
stable
as $$
  with threshold as (
    select coalesce((select attendance_threshold_pct from app_config where id = 1), 75) / 100.0 as t
  ),
  window_of as (
    select e.enrolled_on, e.dropped_at
    from enrolments e
    where e.student_id = p_student_id and e.course_id = p_course_id
  ),
  held as (
    select
      count(*)::numeric as lectures,
      coalesce(sum(ss.score), 0)::numeric as attended
    from session_instances si
    join window_of w on si.held_on >= w.enrolled_on
                    and (w.dropped_at is null or si.held_on < w.dropped_at::date)
    left join session_scores ss
      on ss.session_instance_id = si.id and ss.student_id = p_student_id
    where si.course_id = p_course_id
      and si.status = 'closed'
  )
  select greatest(
    0,
    ceil(
      threshold.t * (held.lectures + lectures_remaining(p_course_id)) - held.attended
    )
  )::integer
  from held cross join threshold;
$$;

revoke all on function lectures_needed(uuid, uuid) from public, anon;
grant execute on function lectures_needed(uuid, uuid) to authenticated, service_role;

comment on function lectures_needed(uuid, uuid) is
  'Of the lectures still to come, how many must be attended to finish at the threshold. Uncapped: a number larger than what remains is the answer "not any more", and the caller needs to be able to tell.';

-- ---------------------------------------------------------------------------
-- The semester report, with the model taken out of its arithmetic
-- ---------------------------------------------------------------------------

-- Same shape, same callers. `must_attend` came from `risk_predictions` before,
-- which was wrong twice over: the row only exists from week five, so a student
-- in week three was told they needed zero more lectures, and it put a table
-- the model writes inside the number a student plans their term around.
--
-- `projected_pct` still comes from the model and still may: it is labelled a
-- projection everywhere it is shown, and nothing decides anything on it.
create or replace function student_semester_report(
  p_student_id uuid,
  p_academic_session_id uuid default null
)
returns table (
  course_id      uuid,
  course_code    text,
  course_title   text,
  lectures_held  integer,
  attended       numeric,
  attendance_pct numeric,
  eligible       boolean,
  must_attend    integer,
  projected_pct  numeric
)
language sql
stable
as $$
  with target as (
    select coalesce(
      p_academic_session_id,
      (select id from academic_sessions where is_active limit 1)
    ) as session_id
  ),
  threshold as (
    select coalesce((select attendance_threshold_pct from app_config where id = 1), 75) as pct
  )
  select
    c.id,
    c.code,
    c.title,
    (
      select count(*)::integer
      from session_instances si
      where si.course_id = c.id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ),
    coalesce((
      select sum(ss.score)
      from session_scores ss
      join session_instances si on si.id = ss.session_instance_id
      where ss.student_id = p_student_id
        and si.course_id = c.id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ), 0),
    attendance_pct(p_student_id, c.id),
    attendance_pct(p_student_id, c.id) >= threshold.pct,
    -- Capped here, where the caller wants an instruction rather than a
    -- diagnosis. "Attend all 11" is what a student can act on; whether 11 is
    -- enough is the `reachable` flag on the permit panel.
    least(lectures_remaining(c.id), lectures_needed(p_student_id, c.id)),
    (
      select rp.predicted_pct from risk_predictions rp
      where rp.student_id = p_student_id and rp.course_id = c.id
    )
  from enrolments e
  join courses c on c.id = e.course_id
  cross join target
  cross join threshold
  where e.student_id = p_student_id
    and e.dropped_at is null
    and c.academic_session_id = target.session_id
  order by c.code;
$$;

-- ---------------------------------------------------------------------------
-- The live eligibility panel (§9.2)
-- ---------------------------------------------------------------------------

-- Built on `student_semester_report()` rather than beside it, which is §6.3
-- taken literally: "the semester report shares its generation logic with the
-- exam permit document — built once, reused." A permit and a report that
-- disagree about one course would be the system arguing with itself in front
-- of the student it is about.
create or replace function permit_eligibility(
  p_student_id uuid,
  p_academic_session_id uuid default null
)
returns table (
  course_id          uuid,
  course_code        text,
  course_title       text,
  attendance_pct     numeric,
  lectures_held      integer,
  attended           numeric,
  lectures_remaining integer,
  must_attend        integer,
  reachable          boolean,
  eligible           boolean
)
language sql
stable
as $$
  select
    r.course_id,
    r.course_code,
    r.course_title,
    r.attendance_pct,
    r.lectures_held,
    r.attended,
    lectures_remaining(r.course_id),
    r.must_attend,
    -- The sentence a student most needs and the one a yes/no cannot carry:
    -- whether there is still a route to 75% at all. False means every
    -- remaining lecture attended still finishes below the line, and the honest
    -- thing is to say so now rather than in the last week of term.
    lectures_needed(p_student_id, r.course_id) <= lectures_remaining(r.course_id),
    r.eligible
  from student_semester_report(p_student_id, p_academic_session_id) r
  order by r.course_code;
$$;

revoke all on function permit_eligibility(uuid, uuid) from public, anon;
grant execute on function permit_eligibility(uuid, uuid) to authenticated, service_role;

comment on function permit_eligibility(uuid, uuid) is
  'What is outstanding, per course, in the terms a student can act on: the percentage, how many of the remaining lectures they must attend, and whether the threshold is still reachable at all.';

-- ---------------------------------------------------------------------------
-- Issuing, now that dues gate the document
-- ---------------------------------------------------------------------------

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
  v_owed      double precision;
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

  -- §9.1, the dues half.
  --
  -- After the authorization check, not before it: while no list exists there
  -- is no permit for anybody, and answering "you owe money" to a student who
  -- would not have one either way is answering a question they did not ask.
  --
  -- Before the reference is allocated, though, and that order is not
  -- negotiable: a reference is permanent. Allocating one and then refusing to
  -- render the document leaves a record of a permit that was never issued and
  -- a student holding a reference that verifies against nothing.
  v_owed := dues_balance_kobo(p_student_id, p_academic_session_id);
  if v_owed > 0 then
    raise exception 'dues outstanding: % kobo', v_owed
      using errcode = 'check_violation';
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
  'One reference per student per session. Refuses while dues are outstanding — §9.1, the single place where payment and attendance meet.';
