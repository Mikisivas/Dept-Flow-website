-- Dept-Flow — deciding waivers and resolving disputes
--
-- Both are authority actions in the same shape as a grace period: an actor, a
-- written reason, an audit row. What differs is the consequence.
--
--   A granted waiver clears the student, which confirms every provisional score
--   they hold — identical in effect to a payment, because that is what a waiver
--   IS: the department deciding the money is not owed.
--
--   A corrected dispute changes an attendance percentage after the fact. That
--   is the most consequential write in the system that is not a payment, and it
--   is why the trail matters more here than anywhere else.

-- ---------------------------------------------------------------------------
-- Waivers
-- ---------------------------------------------------------------------------

create or replace function decide_waiver(
  p_waiver_id uuid,
  p_actor_id  uuid,
  p_grant     boolean,
  p_reason    text
)
returns text
language plpgsql
as $$
declare
  v_row       waivers%rowtype;
  v_confirmed integer := 0;
begin
  if p_actor_id is null then
    raise exception 'a waiver decision must record who made it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a waiver decision must record why';
  end if;

  select * into v_row from waivers where id = p_waiver_id;

  if v_row.id is null then return 'not_found'; end if;
  if v_row.status <> 'pending' then return 'already_decided'; end if;

  update waivers
     set status      = (case when p_grant then 'granted' else 'declined' end)::waiver_status,
         reason      = btrim(p_reason),
         decided_by  = p_actor_id,
         decided_at  = now()
   where id = p_waiver_id;

  -- Granting is not a note on a record: it clears the student, which confirms
  -- every provisional score in one transaction. A waiver that left the marks
  -- provisional would be a kindness that changed nothing.
  if p_grant then
    v_confirmed := clear_student(v_row.student_id, v_row.academic_session_id, 'waiver', p_actor_id);
  end if;

  perform write_audit(
    p_actor_id, 'hod',
    case when p_grant then 'waiver.granted' else 'waiver.declined' end,
    'waivers', p_waiver_id::text, btrim(p_reason),
    jsonb_build_object('student_id', v_row.student_id, 'sessions_confirmed', v_confirmed)
  );

  return case when p_grant then 'granted' else 'declined' end;
end;
$$;

comment on function decide_waiver(uuid, uuid, boolean, text) is
  'Granting clears the student through the same path a payment takes. Declining records the reason and changes nothing else.';

-- ---------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------

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
  v_row     attendance_disputes%rowtype;
  v_score   numeric;
  v_before  numeric;
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
    -- Correcting means the HOD has decided the student was present. The named
    -- checkpoint is accepted; with no checkpoint named the student disputed the
    -- whole lecture, so every checkpoint of it is.
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
  'Correcting accepts the marks and re-scores through resolve_session_score. Both scores are written to the audit row.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function decide_waiver(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function resolve_dispute(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function decide_waiver(uuid, uuid, boolean, text) to service_role;
grant execute on function resolve_dispute(uuid, uuid, boolean, text) to service_role;
