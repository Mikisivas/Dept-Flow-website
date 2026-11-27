-- Dept-Flow — authorizing an exam eligibility list
--
-- The department's formal record of who may sit a paper. The screen for it has
-- existed since the first build and did nothing at all: "Authorize list"
-- flipped a variable in the browser and the page went on recomputing from live
-- data, so the "authorized" list changed every time anybody's attendance did.
--
-- Authorizing has to SNAPSHOT. That is the entire point of freezing one: a
-- grace period opened next week, or a dispute corrected next month, must not
-- retroactively alter the list an exam board already sat with. The numbers are
-- copied into eligibility_entries at the moment of authorization and the
-- existing `eligibility_entries_frozen` trigger stops anything touching them
-- afterwards.

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
        and ss.status = 'confirmed'
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

comment on function authorize_eligibility_list(uuid, uuid, text) is
  'Snapshots every enrolled student''s percentage into eligibility_entries and freezes the list. A correction is a new list, never an edit.';

revoke all on function authorize_eligibility_list(uuid, uuid, text) from public, anon, authenticated;
grant execute on function authorize_eligibility_list(uuid, uuid, text) to service_role;
