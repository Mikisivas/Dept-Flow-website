-- Dept-Flow — the paper register
--
-- The one route into attendance that bypasses every anti-proxy check the
-- system has: no token, no geo-fence, no device heuristic. A lecturer
-- transcribing a sign-in sheet can mark anybody present.
--
-- The screen for it has existed since the first build, complete with its
-- warning and its mandatory justification, and its confirm button closed the
-- dialog and wrote nothing. So the fallback for a network outage did not
-- exist, and the HOD's lecturer-oversight screen — which exists precisely to
-- watch how often this is used — could only ever report zero.
--
-- What makes this a monitored path rather than a silent backdoor is that the
-- batch is a row. `manual_attendance_batches` records who, when, how many and
-- why, and every score it produces carries `manual_batch_id` and
-- `source = 'manually_entered'`, so a mark entered from paper can always be
-- told apart from one a student submitted. None of that is optional here: the
-- batch is created first and the scores are written through it.


-- ---------------------------------------------------------------------------
-- One place decides how a score row is written
-- ---------------------------------------------------------------------------

-- `resolve_session_score` counts accepted checkpoint marks. A paper batch has
-- none — the sheet is the record — so the transcribed score has to be supplied
-- rather than derived.
--
-- Given as an override on the existing function rather than a second function
-- that writes `session_scores` itself. The rule that decides whether a score
-- lands confirmed or provisional lives here, and a paper mark must obey it
-- identically: a transcription for an unpaid student stays provisional,
-- because the fallback is for the network and not for the money. Two functions
-- would be two copies of that rule, and they would drift.
-- Dropped first, and this matters: adding a parameter to a function that has
-- defaults does not replace it, it creates an overload. Both would then match
-- `resolve_session_score(student, session)` and every existing two-argument
-- call — of which there are several, including inside resolve_dispute — would
-- fail with "function is not unique".
drop function if exists resolve_session_score(uuid, uuid, score_source, uuid);

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

  if p_override_score is not null then
    if p_override_score not in (0, 0.5, 1.0) then
      raise exception 'a score is 0, 0.5 or 1.0 — never anything between';
    end if;
    if v_mode = 'single' and p_override_score = 0.5 then
      raise exception 'a single-checkpoint session cannot score 0.5';
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

    if v_mode = 'single' then
      v_score := case when v_accepted >= 1 then 1.0 else 0 end;
    else
      v_score := case v_accepted when 2 then 1.0 when 1 then 0.5 else 0 end;
    end if;
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
    p_student_id, p_session_instance_id, v_score, v_status, p_source, p_manual_batch_id,
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

revoke all on function resolve_session_score(uuid, uuid, score_source, uuid, numeric) from public, anon, authenticated;
grant execute on function resolve_session_score(uuid, uuid, score_source, uuid, numeric) to service_role;

create or replace function submit_manual_batch(
  p_session_instance_id uuid,
  p_actor_id            uuid,
  p_justification       text,
  -- [{ "student_id": "...", "score": 1.0 }, ...]
  p_marks               jsonb
)
returns table (recorded integer, batch_id uuid)
language plpgsql
as $$
declare
  v_instance session_instances%rowtype;
  v_course   courses%rowtype;
  v_batch    uuid;
  v_count    integer;
  v_bad      integer;
begin
  if p_actor_id is null then
    raise exception 'a paper batch must record who entered it';
  end if;

  -- Longer than the ten characters every other action asks for. This one is
  -- read by the HOD while deciding whether a lecturer is leaning on the paper
  -- route, and "network" is not an account of anything.
  if length(btrim(coalesce(p_justification, ''))) < 20 then
    raise exception 'a paper batch must explain why the normal route could not be used';
  end if;

  select * into v_instance from session_instances where id = p_session_instance_id;
  if v_instance.id is null then return query select 0, null::uuid; return; end if;

  select * into v_course from courses where id = v_instance.course_id;
  if v_course.lecturer_id is distinct from p_actor_id then
    raise exception 'that is not your course';
  end if;

  if v_instance.status = 'cancelled' then
    raise exception 'that lecture was cancelled';
  end if;

  -- Every student in the batch must actually be on the course. Without this a
  -- mistyped id silently awards attendance on a course the student never took,
  -- and it would be discovered at the exam board.
  select count(*) into v_bad
  from jsonb_array_elements(p_marks) as m
  where not exists (
    select 1 from enrolments e
    where e.student_id = (m->>'student_id')::uuid
      and e.course_id = v_instance.course_id
      and e.dropped_at is null
  );

  if v_bad > 0 then
    raise exception 'the batch names % students who are not enrolled in this course', v_bad;
  end if;

  -- The batch row first, so nothing can be written that is not attributable to
  -- it. A score tagged `manually_entered` with no batch behind it would be an
  -- untraceable mark, which is the exact thing this table exists to prevent.
  insert into manual_attendance_batches (
    session_instance_id, submitted_by, justification_note, row_count
  )
  values (
    p_session_instance_id, p_actor_id, btrim(p_justification),
    (select count(*) from jsonb_array_elements(p_marks) as m where (m->>'score')::numeric > 0)
  )
  returning id into v_batch;

  -- Through resolve_session_score, so a paper mark is scored, confirmed and
  -- gated on dues by exactly the same rules as a digital one. A paper entry for
  -- an unpaid student stays provisional — the fallback is for the network, not
  -- for the money.
  select count(*) into v_count
  from jsonb_array_elements(p_marks) as m,
  lateral (
    select resolve_session_score(
      (m->>'student_id')::uuid,
      p_session_instance_id,
      'manually_entered'::score_source,
      v_batch,
      (m->>'score')::numeric
    )
  ) as scored
  where (m->>'score')::numeric > 0;

  -- A lecture recorded on paper is closed by that act. Leaving it open would
  -- let the digital path overwrite the transcription afterwards.
  if v_instance.status <> 'closed' then
    update session_instances
       set status = 'closed',
           closed_at = now(),
           checkpoint_mode = coalesce(checkpoint_mode, 'pair')
     where id = p_session_instance_id;
  end if;

  perform write_audit(
    p_actor_id, 'lecturer', 'manual_batch.submit',
    'manual_attendance_batches', v_batch::text, btrim(p_justification),
    jsonb_build_object(
      'session_instance_id', p_session_instance_id,
      'course_code', v_course.code,
      'held_on', v_instance.held_on,
      'students_marked', v_count
    )
  );

  return query select v_count, v_batch;
end;
$$;

comment on function submit_manual_batch(uuid, uuid, text, jsonb) is
  'The paper fallback. Creates the batch first so no manually-entered score can exist without one, and scores through resolve_session_score so paper marks obey the same rules.';

revoke all on function submit_manual_batch(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function submit_manual_batch(uuid, uuid, text, jsonb) to service_role;
