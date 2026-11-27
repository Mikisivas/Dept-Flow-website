-- Dept-Flow — a correction must never lower a score
--
-- Found by rehearsing the demo rather than by reading the code: correcting a
-- dispute took a student from 0.5 to 0.0.
--
-- `resolve_dispute` accepts the disputed marks and then re-scores through
-- `resolve_session_score`, which is right — a corrected lecture should be
-- scored by the same rules as every other one. But the accept step only has
-- something to do when the lecture has `checkpoints` rows. A lecture recorded
-- from a paper register has none, so nothing was accepted, and the re-score
-- computed the student's mark from an empty set of marks: zero.
--
-- The HOD clicked "correct", meaning the student was present. Ending up with
-- less than they started with is the opposite of the instruction, and it is
-- the kind of failure nobody would report because the screen says it worked.

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
      insert into session_scores (student_id, session_instance_id, score, status, source)
      values (v_row.student_id, v_row.session_instance_id, 1.0, 'provisional', 'manually_entered')
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

comment on function resolve_dispute(uuid, uuid, boolean, text) is
  'Correcting accepts the marks and re-scores, and can never lower the score. Both figures go to the audit row.';

revoke all on function resolve_dispute(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function resolve_dispute(uuid, uuid, boolean, text) to service_role;
