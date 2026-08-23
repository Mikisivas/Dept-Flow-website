-- Dept-Flow — attendance becomes trust-based
--
-- The supervisor's revised operational flow drops location enforcement
-- entirely: "logs PRESENT — no GPS, no distance calculation, no spoofing
-- detection". What replaces it as the thing that makes attendance mean
-- something is not a better fence but a different question — the system stops
-- trying to catch the student who is lying about being in the hall and starts
-- making sure the student who is not in the hall knows what it is costing
-- them. That is migration ..._risk_forecast, not this one. This one takes the
-- enforcement out.
--
-- What goes, and why each one goes rather than being left inert:
--
--   the geo-fence          venues.centre_lat/lng/radius_m, attendance_marks'
--                          coordinates and derived distance, the retention
--                          window and the purge job that served them. Dead
--                          columns holding real students' coordinates are
--                          worse than no columns: the retention promise in
--                          docs/decisions.md is enforced by a job, and a job
--                          nobody runs any more is a promise nobody keeps.
--
--   the anti-proxy         students.device_id and the flagged_for_review pair
--                          on a mark. Device correlation is spoofing detection
--                          by another name.
--
--   the checkpoint pair    two tokens per lecture, and with it the 0.5 score.
--                          The new flow issues one code at the start of the
--                          session, so a lecture is present or absent. Marks
--                          already sitting at 0.5 are rounded UP: the student
--                          answered one of the two codes, which under the new
--                          rule is a student who was there.
--
-- `checkpoints` keeps its table name. It now holds exactly one row per
-- lecture — the attendance code — and renaming it would touch two hundred
-- references across the app, the seed and the schema tests without changing
-- what any of them do. The constraint below is what carries the meaning.

-- ---------------------------------------------------------------------------
-- The student's own view of their marks, out of the way
-- ---------------------------------------------------------------------------

-- `my_attendance_marks` selects both the rejection reason and the checkpoint
-- index, and this migration changes the type of one and drops the other. A
-- view holds a hard dependency on the columns it names, so it comes down first
-- and goes back up at the bottom of the file.
drop view if exists my_attendance_marks;

-- ---------------------------------------------------------------------------
-- Rejection reasons: what the student can now be told
-- ---------------------------------------------------------------------------

-- Two of the five reasons described a check that no longer runs. Postgres
-- cannot drop a value from an enum in place, so the type is rebuilt and the
-- retired reasons fold into the generic one — a historical rejection is still
-- a rejection, and the HOD reading it back needs it to resolve to something.
alter type mark_reject_reason rename to mark_reject_reason_retired;

create type mark_reject_reason as enum (
  'invalid_or_expired_token',
  -- New, and the one that carries the weight now: registration is the gate.
  'not_registered',
  'account_locked',
  'already_submitted'
);

alter table attendance_marks
  alter column reject_reason type mark_reject_reason
  using (
    case reject_reason::text
      when 'outside_geofence'  then 'invalid_or_expired_token'
      when 'failed_anti_spoof' then 'invalid_or_expired_token'
      else reject_reason::text
    end
  )::mark_reject_reason;

drop type mark_reject_reason_retired;

-- ---------------------------------------------------------------------------
-- The purge job goes before the columns it purged
-- ---------------------------------------------------------------------------

drop function if exists purge_expired_coordinates();

-- ---------------------------------------------------------------------------
-- Coordinates, distance and the device heuristic
-- ---------------------------------------------------------------------------

drop index if exists attendance_marks_flagged_idx;
drop index if exists attendance_marks_purge_idx;

alter table attendance_marks
  drop constraint if exists mark_lat_range,
  drop constraint if exists mark_lng_range,
  drop constraint if exists mark_purge_clears_coordinates,
  drop constraint if exists mark_flag_has_reason;

alter table attendance_marks
  drop column if exists gps_lat,
  drop column if exists gps_lng,
  drop column if exists gps_accuracy_m,
  drop column if exists distance_m,
  drop column if exists coordinates_purged_at,
  drop column if exists flagged_for_review,
  drop column if exists flag_reason,
  drop column if exists device_id;

comment on table attendance_marks is
  'One submission attempt per student per lecture. Rejections are kept because the student can dispute them. Nothing here records where the student was.';

drop index if exists students_device_idx;

alter table students
  drop column if exists device_id;

-- ---------------------------------------------------------------------------
-- Venues stop being secret
-- ---------------------------------------------------------------------------

-- `venue_directory` existed because a student who could read the fence centre
-- and radius knew exactly how far from the hall they could stand. With no
-- fence there is nothing on a venue to hide, but the view stays: every screen
-- reads through it, and it is now simply the venue list.
alter table venues
  drop constraint if exists venue_lat_range,
  drop constraint if exists venue_lng_range,
  drop constraint if exists venue_radius_range;

alter table venues
  drop column if exists centre_lat,
  drop column if exists centre_lng,
  drop column if exists radius_m,
  drop column if exists boundary;

comment on table venues is
  'Where a lecture is held. Names only — the geo-fence it used to carry was removed with location enforcement.';

comment on view venue_directory is
  'Venue id and name. Kept as the read path every screen already uses; there is no longer anything on venues it withholds.';

-- ---------------------------------------------------------------------------
-- Configuration for checks that no longer run
-- ---------------------------------------------------------------------------

alter table app_config
  drop constraint if exists app_config_retention_range,
  drop constraint if exists app_config_radius_range;

alter table app_config
  drop column if exists gps_retention_days,
  drop column if exists default_geofence_radius_m;

-- ---------------------------------------------------------------------------
-- One code per lecture
-- ---------------------------------------------------------------------------

-- The scoring trigger reads session_instances.checkpoint_mode, so it goes
-- before the column does.
drop trigger if exists session_scores_single_checkpoint_check on session_scores;
drop function if exists enforce_single_checkpoint_scoring();

alter table session_instances
  drop constraint if exists session_closed_has_mode;

-- A closed lecture still has to say when it closed; what it no longer has to
-- say is how many tokens were issued, because the answer is always one.
alter table session_instances
  add constraint session_closed_has_timestamp check (
    status <> 'closed' or closed_at is not null
  );

alter table session_instances
  drop column if exists checkpoint_mode;

drop type if exists checkpoint_mode;

-- Collapse any lecture that issued two codes onto the first. Second-code marks
-- are re-pointed rather than deleted: a student who answered only the second
-- code was present, and dropping the row would mark them absent.
--
-- A student holding a rejected first mark and an accepted second one is the
-- case that needs care — `unique (student_id, checkpoint_id)` would block the
-- re-point and leave the rejection standing as the whole record. The rejected
-- one goes first so the accepted one can take its place.
delete from attendance_marks losing
 using checkpoints one, checkpoints two, attendance_marks winning
 where losing.checkpoint_id = one.id
   and one.index = 1
   and not losing.accepted
   and two.session_instance_id = one.session_instance_id
   and two.index = 2
   and winning.checkpoint_id = two.id
   and winning.student_id = losing.student_id
   and winning.accepted;

update attendance_marks am
   set checkpoint_id = keep.id
  from checkpoints two
  join checkpoints keep
    on keep.session_instance_id = two.session_instance_id
   and keep.index = 1
 where am.checkpoint_id = two.id
   and two.index = 2
   and not exists (
     select 1 from attendance_marks prior
     where prior.student_id = am.student_id
       and prior.checkpoint_id = keep.id
   );

delete from attendance_marks am
 using checkpoints two
 where am.checkpoint_id = two.id
   and two.index = 2;

delete from checkpoints where index = 2;

alter table checkpoints
  drop constraint if exists checkpoints_session_instance_id_index_key,
  drop constraint if exists checkpoint_index_valid;

alter table checkpoints
  drop column if exists index;

alter table checkpoints
  add constraint checkpoints_one_per_session unique (session_instance_id);

comment on table checkpoints is
  'The attendance code: one short-lived 4-digit code per lecture, issued at the start and written on the board. Rotating an expired code updates this row rather than adding one.';

-- ---------------------------------------------------------------------------
-- A lecture is attended or it is not
-- ---------------------------------------------------------------------------

-- Half marks only ever meant "answered one of two codes". Rounded up, for the
-- reason in the header: under the new rule that student was in the room.
update session_scores set score = 1.0 where score = 0.5;

alter table session_scores
  drop constraint if exists score_value_valid;

alter table session_scores
  add constraint score_value_valid check (score in (0, 1.0));

comment on column session_scores.score is
  'Present (1.0) or absent (0). The 0.5 that a half-answered checkpoint pair used to earn went with the pair.';

-- ---------------------------------------------------------------------------
-- Scoring, without the pair
-- ---------------------------------------------------------------------------

-- Same signature as the version in ..._manual_batch.sql, so every existing
-- caller — resolve_dispute and submit_manual_batch among them — keeps working.
-- Two things change: a score is derived from "did an accepted mark exist"
-- rather than from counting two of them, and the readiness check moves from
-- checkpoint_mode (dropped above) to the lecture's own status.
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
  v_accepted      integer;
  v_score         numeric(2,1);
  v_status        score_status;
  v_academic_session uuid;
  v_compliance    compliance_state;
begin
  select si.status, c.academic_session_id
    into v_status_of_lecture, v_academic_session
  from session_instances si
  join courses c on c.id = si.course_id
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

  -- Unchanged here, and removed one migration later: ..._payment_decoupled
  -- takes dues out of the counting rule entirely. Left in place for now so
  -- this migration is exactly one change.
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

revoke all on function resolve_session_score(uuid, uuid, score_source, uuid, numeric)
  from public, anon, authenticated;
grant execute on function resolve_session_score(uuid, uuid, score_source, uuid, numeric)
  to service_role;

comment on function resolve_session_score(uuid, uuid, score_source, uuid, numeric) is
  'One lecture, one student, present or absent. Derived from accepted marks unless a paper batch supplies the score.';

-- ---------------------------------------------------------------------------
-- The paper register, which wrote to a column that is now gone
-- ---------------------------------------------------------------------------

-- `submit_manual_batch` closed a transcribed lecture with
-- `checkpoint_mode = coalesce(checkpoint_mode, 'pair')`. That column has just
-- been dropped, and a plpgsql body is not checked until it runs, so leaving it
-- would have made the outage fallback fail at the exact moment it is needed.
--
-- Reordered as well as repaired. It used to score every student and then close
-- the lecture, which worked only because readiness was judged by
-- `checkpoint_mode` — a value the caller had already set. Readiness is now the
-- lecture's own status, so the close has to come first. That is the truer
-- order regardless: a lecture recorded on paper is closed by the act of
-- recording it, and scoring a lecture that is still open was always a
-- contradiction.
create or replace function submit_manual_batch(
  p_session_instance_id uuid,
  p_actor_id            uuid,
  p_justification       text,
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

  -- Closed before anything is scored, for the reason in the header.
  if v_instance.status <> 'closed' then
    update session_instances
       set status = 'closed',
           closed_at = coalesce(closed_at, now())
     where id = p_session_instance_id;
  end if;

  -- The batch row next, so nothing can be written that is not attributable to
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

  -- Through resolve_session_score, so a paper mark obeys the same rules as a
  -- digital one rather than a second copy of them.
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

revoke all on function submit_manual_batch(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function submit_manual_batch(uuid, uuid, text, jsonb) to service_role;

comment on function submit_manual_batch(uuid, uuid, text, jsonb) is
  'The paper fallback. Closes the lecture, creates the batch, then scores through resolve_session_score so paper marks obey the same rules.';

-- ---------------------------------------------------------------------------
-- The student's own view of their marks, rebuilt
-- ---------------------------------------------------------------------------

-- Same view minus `checkpoint_index`, which no longer distinguishes anything:
-- there is one code per lecture, so the session instance identifies the mark.
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
  'A student''s own submission attempts, accepted or not. Never held coordinates; now there are none to hold.';
