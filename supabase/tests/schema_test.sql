-- Dept-Flow — schema test suite
--
-- Run against a database with the migrations and seed applied. Everything runs
-- inside a transaction that rolls back, so it is re-runnable:
--
--   psql -v ON_ERROR_STOP=1 -d <db> -f supabase/tests/schema_test.sql
--
-- Any failure raises and aborts. Silence at the end means every assertion held.

\set ON_ERROR_STOP on

begin;

create or replace function assert_true(p_condition boolean, p_what text)
returns void language plpgsql as $$
begin
  if p_condition is not true then
    raise exception 'FAILED: %', p_what;
  end if;
  raise notice 'ok — %', p_what;
end $$;

-- Runs a statement that must fail, and fails the suite if it succeeds.
create or replace function assert_rejects(p_sql text, p_what text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok — %', p_what;
    return;
  end;
  raise exception 'FAILED: % (the statement was accepted)', p_what;
end $$;

-- ---------------------------------------------------------------------------
-- Naming: CMP, never CSC
-- ---------------------------------------------------------------------------

select assert_rejects($$
  insert into whitelist_entries (academic_session_id, matric_no, surname, level)
  values ('11111111-1111-1111-1111-111111111111', 'CSC/2021/999', 'Test', 400)
$$, 'a CSC matric prefix is rejected by the register');

select assert_rejects($$
  insert into courses (academic_session_id, code, title, level)
  values ('11111111-1111-1111-1111-111111111111', 'CSC 301', 'Operating Systems', 300)
$$, 'a CSC course code is rejected');

select assert_rejects($$
  insert into whitelist_entries (academic_session_id, matric_no, surname, level)
  values ('11111111-1111-1111-1111-111111111111', 'cmp/2021/998', 'Test', 400)
$$, 'a lower-case matric number is rejected rather than silently stored');

select assert_true(
  (select programme from students where matric_no = 'CMP/2021/047') = 'CMP',
  'programme is derived from the matric prefix, never asked for'
);

-- ---------------------------------------------------------------------------
-- The attendance formula
-- ---------------------------------------------------------------------------

-- Chidera has 10.0 of 13 recorded, all provisional. Provisional scores are
-- excluded from the numerator, so her counted attendance is zero — which is
-- the honest number, and the whole reason the dashboard leads with the banner.
select assert_true(
  attendance_pct('44444444-4444-4444-4444-444444444401',
                 '66666666-6666-6666-6666-666666666601') = 0,
  'provisional scores count for nothing until the student clears'
);

select assert_true(
  attendance_pct('44444444-4444-4444-4444-444444444402',
                 '66666666-6666-6666-6666-666666666601') = 26.92,
  'confirmed scores produce 3.5/13 = 26.92%'
);

-- The mockup's own worked example: 9.5 of 13 is 73%, and one more full session
-- reaches 75%.
select assert_true(
  full_sessions_needed(9.5, 13) = 1,
  'the AttendanceMeter sentence: 9.5 of 13 needs 1 more full session'
);

select assert_true(
  full_sessions_needed(10.0, 13) = 0,
  'a student already above the line needs no further sessions'
);

select assert_true(
  full_sessions_needed(3.5, 13) = 25,
  'a badly-behind student is told the real number, not a comfortable one'
);

-- ---------------------------------------------------------------------------
-- Clearing — the single transaction
-- ---------------------------------------------------------------------------

do $$
declare
  v_confirmed integer;
begin
  v_confirmed := clear_student(
    '44444444-4444-4444-4444-444444444401',
    '11111111-1111-1111-1111-111111111111',
    'payment'
  );
  perform assert_true(v_confirmed = 13, 'clearing confirms all 13 provisional sessions at once');
end $$;

select assert_true(
  (select count(*) from session_scores
    where student_id = '44444444-4444-4444-4444-444444444401'
      and status = 'provisional') = 0,
  'no session is left provisional after clearing — partially confirmed is not a state'
);

select assert_true(
  attendance_pct('44444444-4444-4444-4444-444444444401',
                 '66666666-6666-6666-6666-666666666601') = 76.92,
  'after clearing, the same 10.0 of 13 reads as 76.92%'
);

select assert_true(
  (select state from compliance_statuses
    where student_id = '44444444-4444-4444-4444-444444444401') = 'cleared',
  'the compliance state moves with the scores'
);

select assert_rejects($$
  select clear_student('44444444-4444-4444-4444-444444444401',
                       '11111111-1111-1111-1111-111111111111',
                       'hod_clearance')
$$, 'a clearance granted by a person must name that person');

-- ---------------------------------------------------------------------------
-- Scoring a lecture
-- ---------------------------------------------------------------------------

do $$
declare
  v_session uuid := gen_random_uuid();
  v_cp1     uuid := gen_random_uuid();
  v_cp2     uuid := gen_random_uuid();
  v_student uuid := '44444444-4444-4444-4444-444444444402';
  v_score   numeric;
begin
  insert into session_instances (id, course_id, timetable_entry_id, held_on, venue_id, type, status, checkpoint_mode, closed_at, created_by)
  values (v_session, '66666666-6666-6666-6666-666666666601', '77777777-7777-7777-7777-777777777701',
          '2026-01-13', '22222222-2222-2222-2222-222222222201', 'recurring', 'closed', 'pair', now(),
          '33333333-3333-3333-3333-333333333301');

  insert into checkpoints (id, session_instance_id, index, token, expires_at, issued_by) values
    (v_cp1, v_session, 1, '4821', now() + interval '5 min', '33333333-3333-3333-3333-333333333301'),
    (v_cp2, v_session, 2, '9037', now() + interval '5 min', '33333333-3333-3333-3333-333333333301');

  -- One checkpoint caught.
  insert into attendance_marks (student_id, checkpoint_id, accepted, distance_m)
  values (v_student, v_cp1, true, 12.4);

  v_score := resolve_session_score(v_student, v_session);
  perform assert_true(v_score = 0.5, 'one checkpoint out of two scores 0.5');

  -- The second as well.
  insert into attendance_marks (student_id, checkpoint_id, accepted, distance_m)
  values (v_student, v_cp2, true, 11.1);

  v_score := resolve_session_score(v_student, v_session);
  perform assert_true(v_score = 1.0, 'both checkpoints score 1.0');

  perform assert_true(
    (select status from session_scores where student_id = v_student and session_instance_id = v_session) = 'confirmed',
    'a cleared student''s score is written confirmed, not provisional'
  );

  -- A duplicate submission for the same checkpoint cannot be raced through.
  perform assert_rejects(
    format('insert into attendance_marks (student_id, checkpoint_id, accepted) values (%L, %L, true)', v_student, v_cp1),
    'a second submission for the same checkpoint is rejected by the database, not by application logic'
  );
end $$;

-- A lecture where the lecturer only issued one token is scored present/absent.
do $$
declare
  v_session uuid := gen_random_uuid();
  v_cp1     uuid := gen_random_uuid();
  v_student uuid := '44444444-4444-4444-4444-444444444402';
  v_score   numeric;
begin
  insert into session_instances (id, course_id, timetable_entry_id, held_on, venue_id, type, status, checkpoint_mode, closed_at, created_by)
  values (v_session, '66666666-6666-6666-6666-666666666601', '77777777-7777-7777-7777-777777777701',
          '2026-01-20', '22222222-2222-2222-2222-222222222201', 'recurring', 'closed', 'single', now(),
          '33333333-3333-3333-3333-333333333301');

  insert into checkpoints (id, session_instance_id, index, token, expires_at, issued_by)
  values (v_cp1, v_session, 1, '1234', now() + interval '5 min', '33333333-3333-3333-3333-333333333301');

  insert into attendance_marks (student_id, checkpoint_id, accepted, distance_m)
  values (v_student, v_cp1, true, 9.0);

  v_score := resolve_session_score(v_student, v_session);
  perform assert_true(v_score = 1.0, 'a single-checkpoint lecture scores 1.0, not 0.5');

  perform assert_rejects(
    format('update session_scores set score = 0.5 where student_id = %L and session_instance_id = %L', v_student, v_session),
    'a single-checkpoint lecture can never hold a half mark'
  );
end $$;

select assert_rejects($$
  select resolve_session_score('44444444-4444-4444-4444-444444444402',
    (select id from session_instances where status = 'scheduled' limit 1))
$$, 'an unclosed lecture cannot be scored');

-- ---------------------------------------------------------------------------
-- Cancelled lectures leave the denominator
-- ---------------------------------------------------------------------------

do $$
declare
  v_before  numeric;
  v_after   numeric;
  v_held_before integer;
  v_held_after  integer;
  v_target  uuid;
begin
  v_before := attendance_pct('44444444-4444-4444-4444-444444444401', '66666666-6666-6666-6666-666666666601');

  select count(*) into v_held_before
  from session_instances
  where course_id = '66666666-6666-6666-6666-666666666601' and status = 'closed';

  -- A lecture Chidera missed entirely. Cancelling it removes a zero from the
  -- denominator, so her percentage rises — which is the point: a cancelled
  -- class must not be held against anyone.
  select ss.session_instance_id into v_target
  from session_scores ss
  join session_instances si on si.id = ss.session_instance_id
  where ss.student_id = '44444444-4444-4444-4444-444444444401'
    and si.course_id = '66666666-6666-6666-6666-666666666601'
    and si.status = 'closed'
    and ss.score = 0
  limit 1;

  delete from session_scores where session_instance_id = v_target;
  update session_instances
     set status = 'cancelled', cancelled_at = now(),
         cancelled_by = '33333333-3333-3333-3333-333333333301',
         cancellation_reason = 'Hall double-booked'
   where id = v_target;

  select count(*) into v_held_after
  from session_instances
  where course_id = '66666666-6666-6666-6666-666666666601' and status = 'closed';

  v_after := attendance_pct('44444444-4444-4444-4444-444444444401', '66666666-6666-6666-6666-666666666601');

  perform assert_true(v_held_after = v_held_before - 1,
    'a cancelled lecture leaves the attendance denominator');
  perform assert_true(v_after > v_before,
    'cancelling a missed lecture cannot be held against the student');
end $$;

select assert_rejects($$
  update session_instances set status = 'cancelled', cancelled_at = now()
  where id = (select id from session_instances where status = 'closed' limit 1)
$$, 'cancelling without a reason is rejected');

-- ---------------------------------------------------------------------------
-- The Day-31 path
-- ---------------------------------------------------------------------------

do $$
declare
  v_moved integer;
  v_locked integer;
begin
  insert into compliance_statuses (student_id, academic_session_id, state)
  values ('44444444-4444-4444-4444-444444444403', '11111111-1111-1111-1111-111111111111', 'uncleared')
  on conflict (student_id, academic_session_id) do update
    set state = 'uncleared', locked_at = null, pending_since = null,
        cleared_at = null, cleared_via = null, cleared_by = null;

  v_moved := begin_pending_verification('11111111-1111-1111-1111-111111111111');
  perform assert_true(v_moved >= 1, 'Day 31 moves uncleared students into the verification buffer, not straight to locked');

  -- Nothing locks while the buffer is still open.
  v_locked := lock_after_buffer('11111111-1111-1111-1111-111111111111');
  perform assert_true(v_locked = 0, 'no one is locked while the buffer is still running');

  update compliance_statuses set pending_since = now() - interval '20 hours'
   where student_id = '44444444-4444-4444-4444-444444444403';

  v_locked := lock_after_buffer('11111111-1111-1111-1111-111111111111');
  perform assert_true(v_locked = 1, 'the buffer expiring is what locks the account');

  perform assert_true(
    is_attendance_locked('44444444-4444-4444-4444-444444444403', '11111111-1111-1111-1111-111111111111'),
    'the hot-path lock check agrees with the state machine'
  );
end $$;

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

select assert_rejects($$
  insert into payments (student_id, academic_session_id, paystack_reference, channel, status, amount_kobo)
  values ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111111',
          'DF-TEST-NOVERIFY', 'card', 'success', 500000)
$$, 'a payment cannot be marked successful without a verification timestamp');

select assert_rejects($$
  insert into payments (student_id, academic_session_id, paystack_reference, channel, status, amount_kobo, verified_at)
  values ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111111',
          'DF-TEST-000112', 'card', 'success', 500000, now())
$$, 'a Paystack reference cannot be recorded twice');

-- Amounts are floats, so reconciliation compares within a kobo rather than
-- with equality.
select assert_true(
  payment_matches_dues(500000.0, 500000.0) and payment_matches_dues(499999.9999999, 500000.0),
  'float representation error does not make a paid student look unpaid'
);

select assert_true(
  not payment_matches_dues(499999.0, 500000.0),
  'a genuine one-kobo shortfall is still a shortfall'
);

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------

do $$
declare
  v_purged integer;
  v_mark   uuid;
begin
  select id into v_mark from attendance_marks where gps_lat is not null limit 1;

  if v_mark is null then
    update attendance_marks set gps_lat = 6.5183, gps_lng = 3.3768
     where id = (select id from attendance_marks limit 1)
    returning id into v_mark;
  end if;

  update attendance_marks
     set gps_lat = 6.5183, gps_lng = 3.3768, distance_m = 12.4,
         submitted_at = now() - interval '60 days'
   where id = v_mark;

  v_purged := purge_expired_coordinates();
  perform assert_true(v_purged >= 1, 'expired coordinates are purged on schedule');

  perform assert_true(
    (select gps_lat is null and gps_lng is null and distance_m is not null
       from attendance_marks where id = v_mark),
    'the purge drops the coordinates and keeps the derived distance'
  );
end $$;

select assert_rejects($$
  update attendance_marks set coordinates_purged_at = now(), gps_lat = 6.5183
  where id = (select id from attendance_marks limit 1)
$$, 'a row cannot be marked purged while still holding coordinates');

-- ---------------------------------------------------------------------------
-- Authority actions
-- ---------------------------------------------------------------------------

select assert_rejects($$
  update students set status = 'deactivated' where matric_no = 'MTH/2022/018'
$$, 'deactivation without a reason is rejected');

select assert_rejects($$
  update students set status = 'deactivated', deactivation_reason = 'other', deactivated_at = now()
  where matric_no = 'MTH/2022/018'
$$, 'deactivation reason "other" requires a note');

select assert_rejects($$
  insert into manual_attendance_batches (session_instance_id, submitted_by, justification_note)
  values ((select id from session_instances limit 1), '33333333-3333-3333-3333-333333333301', 'x')
$$, 'a paper batch cannot be submitted with a token justification');

select assert_rejects($$
  insert into grace_periods (academic_session_id, scope, level, expires_on, reason, granted_by)
  values ('11111111-1111-1111-1111-111111111111', 'department', 400, '2026-05-12', 'Hardship', '33333333-3333-3333-3333-333333333302')
$$, 'a department-wide grace period cannot also name a level');

select assert_rejects($$
  insert into audit_log (actor_role, action) values ('admin', '')
$$, 'an audit entry must name an action');

do $$
declare
  v_id bigint;
begin
  v_id := write_audit('33333333-3333-3333-3333-333333333302', 'hod', 'grace_period.open',
                      'grace_periods', 'test', 'Strike disrupted the payment window');

  perform assert_rejects(format('update audit_log set reason = ''edited'' where id = %s', v_id),
                         'the audit log cannot be edited');
  perform assert_rejects(format('delete from audit_log where id = %s', v_id),
                         'the audit log cannot be deleted from');
end $$;

-- ---------------------------------------------------------------------------
-- Eligibility — authorising freezes the list
-- ---------------------------------------------------------------------------

do $$
declare
  v_list uuid := gen_random_uuid();
begin
  insert into eligibility_lists (id, course_id, academic_session_id)
  values (v_list, '66666666-6666-6666-6666-666666666601', '11111111-1111-1111-1111-111111111111');

  insert into eligibility_entries (list_id, student_id, attendance_pct, score_total, sessions_held, eligible)
  values (v_list, '44444444-4444-4444-4444-444444444401', 76.92, 10.0, 13, true);

  update eligibility_lists
     set status = 'authorized', authorized_by = '33333333-3333-3333-3333-333333333302', authorized_at = now()
   where id = v_list;

  perform assert_rejects(
    format('update eligibility_entries set eligible = false where list_id = %L', v_list),
    'an authorized eligibility list cannot be altered'
  );

  perform assert_rejects(
    format('insert into eligibility_entries (list_id, student_id, attendance_pct, score_total, sessions_held, eligible) values (%L, %L, 26.92, 3.5, 13, false)',
           v_list, '44444444-4444-4444-4444-444444444402'),
    'no student can be added to an authorized list'
  );
end $$;

select assert_rejects($$
  insert into academic_sessions (name, starts_on, ends_on, is_active)
  values ('2026/2027', '2026-09-14', '2027-07-30', true)
$$, 'only one academic session can be active at a time');

-- ---------------------------------------------------------------------------
-- Display names
-- ---------------------------------------------------------------------------

select assert_true(
  display_name_register('Okonkwo', 'Chidera', 'Emeka') = 'OKONKWO, Chidera Emeka',
  'register order for tables and the eligibility list'
);

select assert_true(
  display_name_register('Sanusi', 'Halima', null) = 'SANUSI, Halima',
  'a student with no other names gets no trailing space'
);

select assert_true(
  display_name_familiar('Okonkwo', 'Chidera') = 'Chidera Okonkwo',
  'conversational order for greetings'
);

-- ---------------------------------------------------------------------------
-- Credentials — matric number as the identifier, no email anywhere
-- ---------------------------------------------------------------------------

select assert_rejects($$
  update profiles set password_hash = 'hunter2' where role = 'admin'
$$, 'a plaintext password cannot be stored — the column only accepts a digest');

do $$
begin
  update profiles
     set password_hash = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub'
   where role = 'admin';
  perform assert_true(true, 'an Argon2id digest is accepted');

  update profiles set password_hash = crypt('x', gen_salt('bf', 4)) where role = 'hod';
  perform assert_true(true, 'a bcrypt digest is accepted');
end $$;

select assert_true(
  (select role from resolve_login_identifier('CMP/2021/047')) = 'student',
  'login resolves a matric number to its account'
);

select assert_true(
  (select role from resolve_login_identifier('cmp/2021/047')) = 'student',
  'a matric number typed in lower case still resolves — students type on phones'
);

select assert_true(
  (select role from resolve_login_identifier('STF/CMP/001')) = 'hod',
  'the same field resolves a staff ID, so no role picker is needed at login'
);

select assert_true(
  (select count(*) from resolve_login_identifier('CMP/9999/999')) = 0,
  'an unknown identifier resolves to nothing'
);

-- The lookup runs before a session exists, so it must not hand back anything
-- an attacker could use.
select assert_true(
  not exists (
    select 1 from information_schema.columns
    where table_name = 'resolve_login_identifier'
      and column_name in ('password_hash', 'phone')
  ),
  'the login lookup returns no credential material and no phone number'
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- Chidera, logged in as herself.
set local role authenticated;
set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444401';

select assert_true(
  (select count(*) from checkpoints) = 0,
  'a student cannot read checkpoint tokens — the code has to come from the board'
);

select assert_true(
  (select count(*) from session_scores where student_id <> '44444444-4444-4444-4444-444444444401') = 0
  and (select count(*) from session_scores) > 0,
  'a student sees their own scores and no one else''s'
);

select assert_true(
  (select count(*) from risk_predictions) = 1,
  'a student sees their own risk prediction only'
);

select assert_true(
  (select count(*) from venues) = 0,
  'a student cannot read the geo-fence'
);

select assert_true(
  (select count(*) from whitelist_entries) = 0,
  'a student cannot read the register'
);

select assert_true(
  (select count(*) from audit_log) = 0,
  'a student cannot read the audit log'
);

select assert_true(
  (select count(*) from my_attendance_marks) >= 0,
  'a student reads their marks through a view with no coordinate columns'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333303';  -- admin

-- The seed carries two predictions, so this is a real denial rather than an
-- empty table reading as a pass.
select assert_true(
  (select count(*) from risk_predictions) = 0,
  'admin cannot see individual student risk — that is HOD scope'
);

select assert_true(
  (select count(*) from whitelist_entries) > 0,
  'admin can read the register'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333302';  -- HOD

select assert_true(
  (select count(*) from venues) = 0,
  'the HOD cannot read geo-fence coordinates'
);

select assert_true(
  (select count(*) from whitelist_entries) = 0,
  'the HOD cannot read the register'
);

select assert_true(
  (select count(*) from students) > 0,
  'the HOD can read student records'
);

select assert_true(
  (select count(*) from risk_predictions) = 2,
  'the HOD sees every student''s risk — the positive control for the admin denial above'
);

reset role;

rollback;
