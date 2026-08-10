-- Dept-Flow — schema test suite
--
-- Runs against a database with the migrations and seed applied. Everything is
-- inside a transaction that rolls back, so it changes nothing and can be run
-- as often as you like.
--
-- Two ways to run it, and it is deliberately plain SQL so both work:
--
--   Supabase SQL Editor — paste the whole file and run. The last statement
--   returns one row per assertion, so you can read the results in the grid.
--
--   psql -v ON_ERROR_STOP=1 -d <db> -f supabase/tests/schema_test.sql
--
-- There are no psql meta-commands in here (no \set, no \echo). Those are
-- client features that the server never sees, and pasting them into the SQL
-- Editor produces a syntax error on the backslash.
--
-- Any failed assertion raises and aborts the run.

begin;

-- Assertions are collected here as well as raised, because the SQL Editor does
-- not surface NOTICE output — without a result set there is nothing to read.
create temporary table assertion_log (
  seq serial primary key,
  what text not null
) on commit drop;

-- The row-level security section later switches to the `authenticated` role to
-- prove what a student can and cannot read. That role needs to reach this log,
-- or every assertion made under it fails on the log rather than on the thing
-- being tested. The temp schema has a generated name, hence the format().
grant all on assertion_log to authenticated;
grant usage, select on sequence assertion_log_seq_seq to authenticated;
do $$
begin
  execute format(
    'grant usage on schema %I to authenticated',
    (select nspname from pg_namespace where oid = pg_my_temp_schema())
  );
end $$;

create or replace function assert_true(p_condition boolean, p_what text)
returns void language plpgsql as $$
begin
  if p_condition is not true then
    raise exception 'FAILED: %', p_what;
  end if;
  insert into assertion_log (what) values (p_what);
  raise notice 'ok — %', p_what;
end $$;

-- Runs a statement that must fail, and fails the suite if it succeeds.
create or replace function assert_rejects(p_sql text, p_what text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    insert into assertion_log (what) values (p_what);
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

-- The consequence, stated as the eligibility list states it. She attended
-- exactly as much before as after; the payment is the only thing that changed,
-- and it is what carries her over the line.
select assert_true(
  attendance_pct('44444444-4444-4444-4444-444444444401',
                 '66666666-6666-6666-6666-666666666601') >= 75,
  'clearing dues alone is what makes her eligible — no attendance was added, only counted'
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
-- Function exposure
--
-- Every function in `public` is published by PostgREST as an RPC, and Postgres
-- grants EXECUTE to PUBLIC by default. Anyone holding the anon key — which
-- ships in the browser bundle — can call anything left exposed.
-- ---------------------------------------------------------------------------

-- The one that mattered: SECURITY DEFINER, so it runs as the owner and ignores
-- every table grant. Exposed, it walks the register.
select assert_true(
  not has_function_privilege('anon', 'resolve_login_identifier(text)', 'execute'),
  'anon cannot call the login lookup — it would enumerate the register'
);

select assert_true(
  not has_function_privilege('authenticated', 'resolve_login_identifier(text)', 'execute'),
  'a signed-in student cannot call the login lookup either'
);

select assert_true(
  has_function_privilege('service_role', 'resolve_login_identifier(text)', 'execute'),
  'the API can still call it'
);

select assert_true(
  not has_function_privilege('anon', 'clear_student(uuid, uuid, clearance_route, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'clear_student(uuid, uuid, clearance_route, uuid)', 'execute'),
  'nobody but the API can clear a student''s dues'
);

select assert_true(
  not has_function_privilege('anon', 'write_audit(uuid, app_role, text, text, text, text, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'write_audit(uuid, app_role, text, text, text, text, jsonb)', 'execute'),
  'nobody but the API can write an audit entry'
);

select assert_true(
  not has_function_privilege('anon', 'resolve_session_score(uuid, uuid, score_source, uuid)', 'execute'),
  'nobody but the API can score a session'
);

-- The policies call these as the caller, so revoking them would fail the whole
-- product closed. This is the positive control for the revokes above.
select assert_true(
  has_function_privilege('authenticated', 'is_hod()', 'execute')
  and has_function_privilege('authenticated', 'teaches_course(uuid)', 'execute'),
  'the functions the RLS policies call stay reachable by signed-in users'
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

-- Counted rather than fixed: the baseline writes one row per course a student
-- is enrolled in, so a number here would break whenever the seed changed. What
-- is being tested is that none of the rows belong to anybody else.
select assert_true(
  (select count(*) from risk_predictions) > 0
  and (select count(*) from risk_predictions
        where student_id <> '44444444-4444-4444-4444-444444444401') = 0,
  'a student sees their own risk predictions and no one else''s'
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

-- Against the total, not a fixed number: this is the positive control for the
-- admin denial above, and what it has to show is that the HOD sees all of them.
select assert_true(
  (select count(*) from risk_predictions) > 0
  and (select count(distinct student_id) from risk_predictions) > 1,
  'the HOD sees every student''s risk — the positive control for the admin denial above'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333301';  -- lecturer

-- A venue name is on the timetable and has to appear on the session screen;
-- the fence centre and radius are what the admin-only policy exists to hide.
-- Splitting them means neither rule has to bend.
select assert_true(
  (select count(*) from venue_directory) = 2,
  'a lecturer can read venue names'
);

select assert_true(
  (select count(*) from venues) = 0,
  'a lecturer still cannot read geo-fence coordinates'
);

reset role;

select assert_true(
  (select count(*) from information_schema.columns
    where table_name = 'venue_directory'
      and column_name in ('centre_lat', 'centre_lng', 'radius_m', 'boundary')) = 0,
  'venue_directory has no coordinate columns at all, not merely hidden ones'
);

-- ---------------------------------------------------------------------------
-- Grace periods
-- ---------------------------------------------------------------------------

-- Grace suspends the consequence of being locked; it does not rewrite the
-- state. Flipping locked students back to `uncleared` would destroy the record
-- of who was locked, leaving revocation to guess who to re-lock, and would make
-- a student under grace indistinguishable from one who never reached day 31.

do $$
declare
  v_session uuid := '11111111-1111-1111-1111-111111111111';
  v_hod     uuid := '33333333-3333-3333-3333-333333333302';
  v_tunde   uuid := '44444444-4444-4444-4444-444444444403'; -- locked, level 300
  v_grace   uuid;
  v_count   integer;
begin
  perform assert_true(
    is_attendance_locked(v_tunde, v_session),
    'a locked student cannot record attendance'
  );

  select students_affected into v_count from grace_period_impact(v_session, 'department', null);
  perform assert_true(v_count >= 1, 'the impact preview counts the locked students in scope');

  v_grace := open_grace_period(v_session, 'department', null, current_date + 14,
                               'Payment portal was unreachable for four days.', v_hod);

  perform assert_true(
    not is_attendance_locked(v_tunde, v_session),
    'an open grace period lets a locked student record attendance again'
  );

  perform assert_true(
    (select state from compliance_statuses
      where student_id = v_tunde and academic_session_id = v_session) = 'locked',
    'and it does so without rewriting the compliance state'
  );

  perform assert_true(
    (select count(*) from audit_log where action = 'grace_period.opened') = 1,
    'opening a grace period writes an audit row naming who and why'
  );

  perform assert_rejects(
    format('select open_grace_period(%L, %L, 300, current_date + 7, %L, %L)',
           v_session, 'level', 'A different reason entirely.', v_hod),
    'a second grace period covering the same students is refused'
  );

  perform assert_rejects(
    format('select revoke_grace_period(%L, %L, %L)', v_grace, v_hod, 'nope'),
    'revoking without a substantive reason is refused'
  );

  perform assert_true(
    revoke_grace_period(v_grace, v_hod, 'Portal is back up and confirmed working.'),
    'the HOD can end a grace period early'
  );

  perform assert_true(
    is_attendance_locked(v_tunde, v_session),
    'revoking re-applies the lock immediately — nothing had to be undone'
  );

  perform assert_true(
    not revoke_grace_period(v_grace, v_hod, 'Trying to revoke the same one twice.'),
    'revoking an already-revoked period is a no-op rather than a second audit row'
  );

  perform assert_true(
    (select count(*) from audit_log where action = 'grace_period.revoked') = 1,
    'exactly one revocation is recorded'
  );
end $$;

-- ---------------------------------------------------------------------------
-- The payment window closes with the lock
-- ---------------------------------------------------------------------------

-- Department decision: the portal is not open all session. A deadline that can
-- be ignored indefinitely is not a deadline, so being locked shuts paying as
-- well as recording — and the same grace period reopens both, because it is one
-- lock rather than two calendars.

do $$
declare
  v_session uuid := '11111111-1111-1111-1111-111111111111';
  v_hod     uuid := '33333333-3333-3333-3333-333333333302';
  v_tunde   uuid := '44444444-4444-4444-4444-444444444403'; -- locked
  v_halima  uuid := '44444444-4444-4444-4444-444444444402'; -- cleared
  v_grace   uuid;
begin
  perform assert_true(
    not is_payment_open(v_tunde, v_session),
    'a locked student cannot start a payment — the deadline is a real one'
  );

  perform assert_true(
    is_payment_open(v_halima, v_session),
    'everyone else can still pay'
  );

  v_grace := open_grace_period(v_session, 'department', null, current_date + 14,
                               'Bursary disbursement was three weeks late.', v_hod);

  perform assert_true(
    is_payment_open(v_tunde, v_session),
    'a grace period reopens payment as well as attendance — one lock, one key'
  );

  perform revoke_grace_period(v_grace, v_hod, 'Disbursement completed and confirmed.');

  perform assert_true(
    not is_payment_open(v_tunde, v_session),
    'and closes both again when it ends'
  );
end $$;

-- ---------------------------------------------------------------------------
-- The deadline actually arriving
-- ---------------------------------------------------------------------------

-- These two transitions existed from the first migration and nothing called
-- them, so the compliance ladder was inert. That became load-bearing when the
-- payment window was tied to the lock: with nothing driving the transition, no
-- student is ever locked and the deadline does not exist.

do $$
declare
  v_session uuid := '11111111-1111-1111-1111-111111111111';
  v_fresh   uuid := gen_random_uuid();
  v_moved   integer;
begin
  insert into profiles (id, role, surname, first_name, phone)
  values (v_fresh, 'student', 'Timely', 'Student', '+2348058888888');
  insert into students (id, matric_no, level) values (v_fresh, 'CMP/2021/888', 300);
  insert into compliance_statuses (student_id, academic_session_id, state)
  values (v_fresh, v_session, 'uncleared');

  -- Resumption far enough back that the provisional window has closed.
  update dues_periods set resumption_date = current_date - 60
   where academic_session_id = v_session;

  v_moved := begin_pending_verification(v_session);
  perform assert_true(
    v_moved > 0,
    'once the provisional window has passed, uncleared students enter the buffer'
  );

  perform assert_true(
    (select state from compliance_statuses
      where student_id = v_fresh and academic_session_id = v_session) = 'pending_verification',
    'they land in pending verification rather than straight into a lock'
  );

  -- Rewind so the deadline has NOT passed, and put them back.
  update compliance_statuses set state = 'uncleared', pending_since = null
   where student_id = v_fresh and academic_session_id = v_session;
  update dues_periods set resumption_date = current_date - 2
   where academic_session_id = v_session;

  perform assert_true(
    begin_pending_verification(v_session) = 0,
    'run before the deadline it moves nobody — the rule is in the function, not in the caller'
  );

  perform assert_true(
    (select state from compliance_statuses
      where student_id = v_fresh and academic_session_id = v_session) = 'uncleared',
    'so a scheduler misfire cannot lock a department out of paying early'
  );
end $$;

-- ---------------------------------------------------------------------------
-- Waivers and disputes
-- ---------------------------------------------------------------------------

-- Both are authority actions in the same shape as a grace period. What differs
-- is the consequence: a granted waiver clears the student, and a corrected
-- dispute changes an attendance percentage after the fact.

do $$
declare
  v_session uuid := '11111111-1111-1111-1111-111111111111';
  v_hod     uuid := '33333333-3333-3333-3333-333333333302';
  v_halima  uuid := '44444444-4444-4444-4444-444444444402';
  v_course  uuid := '66666666-6666-6666-6666-666666666601';
  v_student uuid := gen_random_uuid();
  v_waiver  uuid := gen_random_uuid();
  v_lecture uuid := gen_random_uuid();
  v_cp      uuid := gen_random_uuid();
  v_dispute uuid := gen_random_uuid();
begin
  -- A student of this section's own, so the earlier clearing assertions are
  -- not disturbed by it.
  insert into profiles (id, role, surname, first_name, phone)
  values (v_student, 'student', 'Waiver', 'Candidate', '+2348057777777');
  insert into students (id, matric_no, level) values (v_student, 'CMP/2021/777', 300);
  insert into compliance_statuses (student_id, academic_session_id, state)
  values (v_student, v_session, 'uncleared');
  insert into enrolments (student_id, course_id, source, enrolled_on)
  values (v_student, v_course, 'carry_over', date '2025-09-15');

  insert into session_scores (student_id, session_instance_id, score, status)
  select v_student, si.id, 1.0, 'provisional'
  from session_instances si
  where si.course_id = v_course and si.status = 'closed'
  limit 4;

  insert into waivers (id, student_id, academic_session_id, request_note)
  values (v_waiver, v_student, v_session, 'Father lost his job this term.');

  perform assert_true(
    attendance_pct(v_student, v_course) = 0,
    'a student awaiting a waiver counts for nothing, exactly like one awaiting a payment'
  );

  perform assert_rejects(
    format('select decide_waiver(%L, %L, true, %L)', v_waiver, v_hod, 'ok'),
    'a waiver decision without a substantive reason is refused'
  );

  perform assert_true(
    decide_waiver(v_waiver, v_hod, true, 'Hardship verified with the bursary office.') = 'granted',
    'the HOD can grant a waiver'
  );

  perform assert_true(
    attendance_pct(v_student, v_course) > 0,
    'granting confirms the provisional scores — a waiver that left them waiting would change nothing'
  );

  perform assert_true(
    (select cleared_via from compliance_statuses
      where student_id = v_student and academic_session_id = v_session) = 'waiver',
    'and records the route as a waiver rather than a payment'
  );

  perform assert_true(
    decide_waiver(v_waiver, v_hod, false, 'Trying to decide the same one twice.') = 'already_decided',
    'a decided waiver cannot be decided again'
  );

  -- ------------------------------------------------------------------------
  -- A lecture Halima was rejected on, then disputes
  -- ------------------------------------------------------------------------
  insert into session_instances (id, course_id, timetable_entry_id, held_on, venue_id,
                                 type, status, checkpoint_mode, closed_at, created_by)
  values (v_lecture, v_course, '77777777-7777-7777-7777-777777777701', current_date - 1,
          '22222222-2222-2222-2222-222222222201', 'recurring', 'closed', 'single', now(),
          '33333333-3333-3333-3333-333333333301');

  insert into checkpoints (id, session_instance_id, index, token, issued_at, expires_at, issued_by)
  values (v_cp, v_lecture, 1, '1234', now() - interval '2 hours', now() - interval '1 hour',
          '33333333-3333-3333-3333-333333333301');

  insert into attendance_marks (student_id, checkpoint_id, accepted, reject_reason, distance_m)
  values (v_halima, v_cp, false, 'outside_geofence', 87);

  perform resolve_session_score(v_halima, v_lecture);

  perform assert_true(
    (select score from session_scores
      where student_id = v_halima and session_instance_id = v_lecture) = 0,
    'a rejected submission scores zero'
  );

  insert into attendance_disputes (id, student_id, session_instance_id, checkpoint_id, student_note)
  values (v_dispute, v_halima, v_lecture, v_cp, 'I was in the third row the whole lecture.');

  perform assert_true(
    resolve_dispute(v_dispute, v_hod, false, 'Lecturer confirms she was present and signed the sheet.')
      = 'corrected',
    'the HOD can correct a disputed mark'
  );

  perform assert_true(
    (select score from session_scores
      where student_id = v_halima and session_instance_id = v_lecture) = 1.0,
    'correcting re-scores through resolve_session_score, by the same rules as every other lecture'
  );

  perform assert_true(
    (select (metadata->>'score_before')::numeric from audit_log
      where action = 'dispute.corrected') = 0
    and (select (metadata->>'score_after')::numeric from audit_log
      where action = 'dispute.corrected') = 1.0,
    'the audit row records both scores — "it changed" is not a defensible answer later'
  );

  perform assert_true(
    resolve_dispute(v_dispute, v_hod, true, 'Trying to resolve it a second time.')
      = 'already_resolved',
    'a resolved dispute cannot be resolved again'
  );
end $$;

-- ---------------------------------------------------------------------------
-- Course registration
-- ---------------------------------------------------------------------------

-- Enrolment is the DENOMINATOR of the attendance formula, so none of this is
-- administrative tidiness: it decides which lectures count against a student,
-- and therefore who sits an exam.

do $$
declare
  v_session uuid := '11111111-1111-1111-1111-111111111111';
  v_cmp301  uuid := '66666666-6666-6666-6666-666666666601'; -- core 300, 3 units
  v_mth205  uuid := '66666666-6666-6666-6666-666666666602'; -- core 200, 3 units
  v_sta202  uuid := '66666666-6666-6666-6666-666666666603'; -- elective 200, 2 units
  v_tunde   uuid := '44444444-4444-4444-4444-444444444403'; -- 300 level
  v_late    uuid := gen_random_uuid();
  v_extra   uuid := gen_random_uuid();
  v_mine    integer;
  v_all     integer;
begin
  -- The one that matters most: a course joined in week 8 does not inherit the
  -- absences from the lectures held before the student was on it.
  insert into profiles (id, role, surname, first_name, phone)
  values (v_late, 'student', 'Late', 'Joiner', '+2348059999999');
  insert into students (id, matric_no, level) values (v_late, 'CMP/2021/999', 300);
  insert into enrolments (student_id, course_id, source, enrolled_on)
  values (v_late, v_cmp301, 'carry_over', date '2025-11-18');

  -- Counted rather than hardcoded: an earlier assertion in this suite cancels
  -- a lecture, and a fixed number here would break on that rather than on
  -- anything to do with enrolment.
  select count(*) into v_mine
  from session_instances si
  where si.course_id = v_cmp301 and si.status = 'closed'
    and si.held_on >= date '2025-11-18';

  select count(*) into v_all
  from session_instances si
  where si.course_id = v_cmp301 and si.status = 'closed';

  perform assert_true(
    v_mine < v_all and v_mine > 0,
    'a student joining part-way through has fewer lectures in their denominator than the course held'
  );

  perform assert_true(
    attendance_pct(v_late, v_cmp301) = 0,
    'a late joiner with no marks is at 0% over their own denominator, not the course''s'
  );

  -- One full mark, and the percentage is that mark over the lectures held
  -- since they joined. Against the whole course it would read far lower — this
  -- is the difference between a fair number and one that bars someone from an
  -- exam over classes they could not have attended.
  insert into session_scores (student_id, session_instance_id, score, status, confirmed_at)
  select v_late, si.id, 1.0, 'confirmed', now()
  from session_instances si
  where si.course_id = v_cmp301 and si.status = 'closed'
    and si.held_on >= date '2025-11-18'
  order by si.held_on
  limit 1;

  perform assert_true(
    attendance_pct(v_late, v_cmp301) = round(1.0 / v_mine * 100, 2),
    'the denominator is the lectures held since joining, not every lecture the course held'
  );

  perform assert_true(
    enrol_in_core_courses(v_tunde, v_session) = 1,
    'core enrolment adds every core course at the student''s level'
  );

  perform assert_true(
    enrol_in_core_courses(v_tunde, v_session) = 0,
    'core enrolment is idempotent, so re-running it after an upload resets no join date'
  );

  perform assert_true(
    add_optional_course(v_tunde, v_cmp301) = 'core_not_optional',
    'a core course at the student''s own level cannot be opted into'
  );

  perform assert_true(
    add_optional_course(v_tunde, v_mth205) = 'already_enrolled',
    'an optional course already held says so rather than duplicating'
  );

  perform assert_true(
    (select source from enrolments where student_id = v_tunde and course_id = v_mth205)
      = 'carry_over',
    'a course below the student''s level is recorded as a carry-over'
  );

  perform assert_true(
    add_optional_course(v_tunde, v_sta202) = 'added',
    'a lower-level elective can be added'
  );

  perform assert_true(
    student_credit_units(v_tunde, v_session, 1::smallint) = 8,
    'credit units count core, electives and carry-overs alike'
  );

  -- The cap, exercised at 12 so the seeded courses can reach it.
  update app_config set max_credit_units_per_semester = 12 where id = 1;
  insert into courses (id, academic_session_id, code, title, level, kind, credit_units, semester)
  values (v_extra, v_session, 'CMP 302', 'Compilers', 300, 'elective', 6, 1);

  perform assert_true(
    add_optional_course(v_tunde, v_extra) = 'over_credit_limit',
    'the credit cap refuses a course that would take the student over it'
  );

  update app_config set max_credit_units_per_semester = 24 where id = 1;
  perform assert_true(
    add_optional_course(v_tunde, v_extra) = 'added',
    'the same course fits once the cap is raised, so the cap is the only thing refusing it'
  );

  perform assert_true(
    drop_optional_course(v_tunde, v_cmp301) = 'core_not_optional',
    'a core course cannot be dropped — a student could otherwise stop being tracked'
  );

  perform assert_true(
    drop_optional_course(v_tunde, v_sta202) = 'dropped',
    'an elective can be dropped'
  );

  perform assert_true(
    student_credit_units(v_tunde, v_session, 1::smallint) = 12,
    'dropping releases its credit units'
  );

  perform assert_true(
    (select dropped_at from enrolments
      where student_id = v_tunde and course_id = v_sta202) is not null,
    'dropping records rather than deletes, so the join date survives'
  );

  update enrolments set enrolled_on = date '2025-09-15'
   where student_id = v_tunde and course_id = v_sta202;
  perform add_optional_course(v_tunde, v_sta202);

  perform assert_true(
    (select enrolled_on from enrolments
      where student_id = v_tunde and course_id = v_sta202) = date '2025-09-15',
    're-adding a dropped course keeps its join date, so drop-and-re-add cannot erase absences'
  );
end $$;




-- ---------------------------------------------------------------------------
-- Authorizing an exam eligibility list
--
-- On its own course and its own student. An earlier block already authorizes a
-- list for CMP 301 to prove the freeze trigger, and reusing it here would test
-- the collision rather than the function.
-- ---------------------------------------------------------------------------

do $$
declare
  v_hod     uuid := '33333333-3333-3333-3333-333333333302';
  v_admin   uuid := '33333333-3333-3333-3333-333333333303';
  v_session uuid := '11111111-1111-1111-1111-111111111111';
  v_lect    uuid := '33333333-3333-3333-3333-333333333301';
  v_venue   uuid := '22222222-2222-2222-2222-222222222201';
  v_course  uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();
  v_lecture uuid := gen_random_uuid();
  v_list    uuid;
  v_e       integer;
  v_n       integer;
  v_snap    numeric;
  v_ok      boolean;
begin
  insert into courses (id, academic_session_id, code, title, level, lecturer_id, kind, credit_units, semester)
  values (v_course, v_session, 'CMP 499', 'Project', 400, v_lect, 'core', 3, 1);

  insert into profiles (id, role, surname, first_name, phone)
  values (v_student, 'student', 'Eligible', 'Test', '+2348055555555');
  insert into students (id, matric_no, level) values (v_student, 'CMP/2021/555', 400);
  insert into enrolments (student_id, course_id, source, enrolled_on)
  values (v_student, v_course, 'core', date '2025-09-15');

  insert into session_instances (id, course_id, held_on, venue_id, type, status, checkpoint_mode, closed_at, created_by)
  values (v_lecture, v_course, date '2025-10-07', v_venue, 'makeup', 'closed', 'pair', now(), v_lect);

  -- One lecture, attended in full, but provisional: the student has not paid.
  insert into session_scores (student_id, session_instance_id, score, status, source)
  values (v_student, v_lecture, 1.0, 'provisional', 'digital');

  begin
    perform authorize_eligibility_list(v_course, v_hod, 'ok');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform assert_true(v_ok, 'authorizing without a substantive note is refused');

  begin
    perform authorize_eligibility_list(v_course, v_admin, 'The administrator is not the head of department.');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform assert_true(v_ok, 'only the head of department can authorize an eligibility list');

  select eligible, not_eligible into v_e, v_n
  from authorize_eligibility_list(v_course, v_hod, 'Final list for the 2025/2026 first semester.');

  perform assert_true(v_e + v_n > 0, 'authorizing snapshots every enrolled student');

  perform assert_true(
    v_e = 0 and v_n = 1,
    'a student whose only attendance is provisional is recorded as not eligible — the money is what counts it'
  );

  select id into v_list from eligibility_lists where course_id = v_course;
  perform assert_true(
    (select status from eligibility_lists where id = v_list) = 'authorized'
      and (select authorized_by from eligibility_lists where id = v_list) = v_hod,
    'the list records who froze it and when'
  );

  select attendance_pct into v_snap
  from eligibility_entries where list_id = v_list and student_id = v_student;

  perform assert_true(
    v_snap = attendance_pct(v_student, v_course),
    'the snapshot matches what every other screen was showing at the time'
  );

  perform assert_true(
    (select count(*) from audit_log
      where action = 'eligibility.authorize' and target_id = v_list::text) = 1,
    'authorizing writes an audit row'
  );

  -- The freeze is the whole point: clearing this student afterwards takes them
  -- from 0% to 100%, and must NOT move the list an exam board already sat with.
  perform clear_student(v_student, v_session, 'payment');

  perform assert_true(
    attendance_pct(v_student, v_course) = 100,
    'clearing takes the student to 100% live'
  );

  perform assert_true(
    (select attendance_pct from eligibility_entries
      where list_id = v_list and student_id = v_student) = v_snap,
    'and the frozen list still says what it said — a correction is a new list, never an edit'
  );

  select eligible, not_eligible into v_e, v_n
  from authorize_eligibility_list(v_course, v_hod, 'Trying to authorize the same list twice.');
  perform assert_true(v_e = 0 and v_n = 0, 'an authorized list cannot be authorized again');

  perform assert_true(
    (select count(*) from audit_log
      where action = 'eligibility.authorize' and target_id = v_list::text) = 1,
    'and the second attempt writes no second audit row'
  );
end $$;

-- ---------------------------------------------------------------------------
-- Schedule changes: cancelling, makeups, reschedules
--
-- Placed before the admin block, because the rollover at the end changes every
-- student's level and switches the active session.
-- ---------------------------------------------------------------------------

do $$
declare
  v_lect   uuid := '33333333-3333-3333-3333-333333333301'; -- Bello, teaches all three
  v_hod    uuid := '33333333-3333-3333-3333-333333333302';
  v_cmp301 uuid := '66666666-6666-6666-6666-666666666601';
  v_sta202 uuid := '66666666-6666-6666-6666-666666666603';
  v_entry  uuid := '77777777-7777-7777-7777-777777777701';
  v_venue  uuid := '22222222-2222-2222-2222-222222222201';
  v_future date := current_date + 7;
  v_held   date;
  v_before integer;
  v_after  integer;
  v_ok     boolean;
begin
  select count(*) into v_before from notifications;

  -- ==== cancel_session ====

  begin
    perform cancel_session(v_cmp301, v_entry, v_future, v_lect, 'busy');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform assert_true(v_ok, 'a cancellation without a substantive reason is refused — students are shown it');

  perform assert_true(
    cancel_session(v_cmp301, v_entry, v_future, v_hod, 'The HOD is not the lecturer for this course.') = 'not_your_course',
    'a lecturer cannot cancel another lecturer''s lecture'
  );

  perform assert_true(
    cancel_session(v_cmp301, v_entry, v_future, v_lect, 'Departmental seminar clashes with this slot.') = 'cancelled',
    'the lecturer can cancel a future lecture that has no instance row yet'
  );

  perform assert_true(
    (select status from session_instances where course_id = v_cmp301 and held_on = v_future) = 'cancelled',
    'cancelling writes an instance rather than deleting one — the absence is recorded'
  );

  perform assert_true(
    (select venue_id from session_instances where course_id = v_cmp301 and held_on = v_future) = v_venue,
    'the cancelled instance carries the venue from the timetable entry'
  );

  select count(*) into v_after from notifications;
  perform assert_true(
    v_after > v_before,
    'cancelling notifies the enrolled students, as the screen promises'
  );

  perform assert_true(
    (select count(*) from notifications n
      join enrolments e on e.student_id = n.recipient_id and e.course_id = v_cmp301
     where n.kind = 'schedule_change') > 0,
    'the notification goes to students enrolled in that course'
  );

  perform assert_true(
    cancel_session(v_cmp301, v_entry, v_future, v_lect, 'Trying to cancel the very same lecture twice.') = 'already_cancelled',
    'a cancelled lecture cannot be cancelled again'
  );

  -- A lecture already held must not be cancellable: it would drop out of every
  -- enrolled student's denominator and move percentages for students who came.
  select held_on into v_held
  from session_instances
  where course_id = v_cmp301 and status = 'closed'
  order by held_on limit 1;

  perform assert_true(
    cancel_session(v_cmp301, v_entry, v_held, v_lect, 'Trying to cancel a lecture that was actually taught.') = 'already_held',
    'a lecture that was held cannot be cancelled — that would move every student''s percentage'
  );

  -- ==== schedule_makeup ====

  begin
    perform schedule_makeup(v_sta202, current_date - 1, time '15:00', time '17:00', v_venue, v_lect, null);
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform assert_true(v_ok, 'a makeup class cannot be scheduled in the past');

  begin
    perform schedule_makeup(v_sta202, v_future, time '17:00', time '15:00', v_venue, v_lect, null);
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform assert_true(v_ok, 'a makeup class must end after it starts');

  perform assert_true(
    schedule_makeup(v_sta202, v_future, time '15:00', time '17:00', v_venue, v_hod, null) = 'not_your_course',
    'a makeup can only be scheduled by the course''s own lecturer'
  );

  perform assert_true(
    schedule_makeup(v_sta202, v_future, time '15:00', time '17:00', gen_random_uuid(), v_lect, null) = 'no_such_venue',
    'a makeup class needs a real venue — the geo-fence comes from it'
  );

  perform assert_true(
    schedule_makeup(v_sta202, v_future, time '15:00', time '17:00', v_venue, v_lect, 'Replacing the lecture lost to the seminar.') = 'scheduled',
    'the lecturer can schedule a makeup class'
  );

  perform assert_true(
    (select type from session_instances where course_id = v_sta202 and held_on = v_future) = 'makeup'
      and (select timetable_entry_id from session_instances where course_id = v_sta202 and held_on = v_future) is null,
    'a makeup has no timetable entry — it is not a recurring slot'
  );

  perform assert_true(
    schedule_makeup(v_sta202, v_future, time '18:00', time '20:00', v_venue, v_lect, null) = 'already_scheduled',
    'two lectures for one course on one day is a double-tap, not an intention'
  );

  -- Cancelling frees the day again, which is the whole point of a makeup after
  -- a cancellation.
  perform cancel_session(v_sta202, null, v_future, v_lect, 'Venue double-booked, moving it again.');
  perform assert_true(
    schedule_makeup(v_sta202, v_future, time '18:00', time '20:00', v_venue, v_lect, null) = 'scheduled',
    'once cancelled, the day is free for another makeup'
  );

  -- ==== reschedule_session ====

  perform assert_true(
    reschedule_session(v_cmp301, v_entry, v_future + 7, v_future + 8, time '10:00', time '12:00',
                       v_venue, v_lect, 'Venue needed for an external examination.') = 'rescheduled',
    'the lecturer can move a lecture to another day'
  );

  perform assert_true(
    (select status from session_instances where course_id = v_cmp301 and held_on = v_future + 7) = 'cancelled'
      and (select type from session_instances where course_id = v_cmp301 and held_on = v_future + 8) = 'reschedule',
    'the old slot is cancelled and the new one is marked a reschedule — nothing is deleted'
  );

  perform assert_true(
    (select count(*) from notifications
      where kind = 'schedule_change' and title like '%has moved to%') > 0,
    'a reschedule sends one notification, not a cancellation and an addition'
  );

  begin
    perform reschedule_session(v_cmp301, v_entry, v_future + 14, current_date - 1, time '10:00', time '12:00',
                               v_venue, v_lect, 'Trying to move a lecture backwards in time.');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform assert_true(v_ok, 'a lecture cannot be moved into the past');
end $$;

-- ---------------------------------------------------------------------------
-- The administrator's authority actions
--
-- Deliberately last: the rollover changes every student's level and switches
-- the active session, so nothing after it would be testing what it thinks.
-- ---------------------------------------------------------------------------

do $$
declare
  v_admin   uuid := '33333333-3333-3333-3333-333333333303';
  v_session uuid := '11111111-1111-1111-1111-111111111111';
  v_chidera uuid := '44444444-4444-4444-4444-444444444401'; -- 400
  v_halima  uuid := '44444444-4444-4444-4444-444444444402'; -- 400
  v_tunde   uuid := '44444444-4444-4444-4444-444444444403'; -- 300
  v_next    uuid := gen_random_uuid();
  v_dispute uuid;
  v_result  text;
  v_promoted   integer;
  v_graduating integer;
  v_was_final  integer;
  v_was_junior integer;
  v_ok      boolean;
begin
  -- ==== deactivate_student ====

  begin
    perform deactivate_student(v_chidera, null, 'withdrawn', 'Left the programme in October.');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform assert_true(v_ok, 'a deactivation with no actor is refused');

  begin
    perform deactivate_student(v_chidera, v_admin, 'withdrawn', 'left');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform assert_true(v_ok, 'a deactivation without a substantive note is refused');

  perform assert_true(
    deactivate_student(v_chidera, v_admin, 'withdrawn', 'Withdrew from the programme, letter on file.') = 'deactivated',
    'the admin can deactivate a student'
  );

  perform assert_true(
    (select status from students where id = v_chidera) = 'deactivated'
      and (select deactivated_by from students where id = v_chidera) = v_admin,
    'deactivating records who did it'
  );

  perform assert_true(
    (select count(*) from session_scores where student_id = v_chidera) > 0,
    'deactivating keeps their attendance history — it is a soft delete, not a delete'
  );

  perform assert_true(
    (select count(*) from audit_log
      where action = 'student.deactivate' and target_id = v_chidera::text) = 1,
    'deactivating writes an audit row'
  );

  perform assert_true(
    deactivate_student(v_chidera, v_admin, 'withdrawn', 'Trying the same thing twice over.') = 'already_deactivated',
    'a deactivated student cannot be deactivated again'
  );

  perform assert_true(
    reactivate_student(v_chidera, v_admin, 'Clerical error — wrong student was selected.') = 'reactivated',
    'the admin can reverse a deactivation'
  );

  perform assert_true(
    (select metadata->>'previous_reason' from audit_log
      where action = 'student.reactivate' and target_id = v_chidera::text) = 'withdrawn',
    'reactivating carries the old reason into the audit row before clearing it'
  );

  perform assert_true(
    (select status from students where id = v_chidera) = 'active'
      and (select deactivation_reason from students where id = v_chidera) is null,
    'a reactivated student is active again with no deactivation reason left behind'
  );

  -- ==== resolve_registration_dispute ====

  insert into registration_disputes (matric_no, academic_session_id, reporter_phone)
  values ('CMP/2021/112', v_session, '+2348031234567')
  returning id into v_dispute;

  update whitelist_entries set claimed = true, claimed_by = v_halima, claimed_at = now()
   where matric_no = 'CMP/2021/112' and academic_session_id = v_session;

  begin
    perform resolve_registration_dispute(v_dispute, v_admin, true, 'nope');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform assert_true(v_ok, 'a registration dispute cannot be resolved without a substantive reason');

  perform assert_true(
    resolve_registration_dispute(v_dispute, v_admin, true, 'Impostor claim confirmed at the department office with student ID.') = 'revoked',
    'the admin can revoke a fraudulent registration'
  );

  perform assert_true(
    (select status from students where id = v_halima) = 'deactivated',
    'revoking deactivates the claiming account'
  );

  perform assert_true(
    (select claimed from whitelist_entries
      where matric_no = 'CMP/2021/112' and academic_session_id = v_session) = false,
    'revoking frees the register row, so the real student can register'
  );

  perform assert_true(
    resolve_registration_dispute(v_dispute, v_admin, false, 'Trying to resolve it a second time.') = 'already_resolved',
    'a resolved registration dispute cannot be resolved again'
  );

  -- Dismissal leaves the account alone but is still recorded.
  insert into registration_disputes (matric_no, academic_session_id, reporter_phone)
  values ('MTH/2022/018', v_session, '+2348039999999')
  returning id into v_dispute;

  perform assert_true(
    resolve_registration_dispute(v_dispute, v_admin, false, 'Caller could not produce a student ID; claim stands.') = 'dismissed',
    'the admin can dismiss a registration dispute'
  );

  perform assert_true(
    (select status from students where id = v_tunde) <> 'deactivated',
    'dismissing changes nothing about the account'
  );

  perform assert_true(
    (select count(*) from audit_log
      where action = 'registration.dispute_dismissed' and target_id = v_dispute::text) = 1,
    'dismissing is written down too — a rejection with no record is asked about again'
  );

  perform assert_true(
    (select count(*) from audit_log
      where action = 'student.deactivate' and target_id = v_halima::text) = 1,
    'revoking goes through deactivate_student, so the closure is recorded where anyone would look for it'
  );

  -- ==== run_level_rollover ====

  perform reactivate_student(v_halima, v_admin, 'Restoring for the rollover assertions below.');

  insert into academic_sessions (id, name, starts_on, ends_on, is_active)
  values (v_next, '2026/2027', date '2026-09-14', date '2027-07-30', false);

  begin
    perform run_level_rollover(v_session, v_admin, 'Rolling a session into itself.');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform assert_true(v_ok, 'a session cannot be rolled over into itself');

  begin
    perform run_level_rollover(v_next, null, 'End of the 2025/2026 session.');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform assert_true(v_ok, 'a rollover with no actor is refused');

  -- Counted rather than hardcoded: earlier assertions in this suite add
  -- students, and a fixed number here would break on that rather than on
  -- anything to do with the rollover.
  select count(*) filter (where level = 400), count(*) filter (where level < 400)
    into v_was_final, v_was_junior
  from students where status = 'active';

  select promoted, graduating into v_promoted, v_graduating
  from run_level_rollover(v_next, v_admin, 'End of the 2025/2026 session, senate minute 14.');

  perform assert_true(
    v_graduating = v_was_final and v_promoted = v_was_junior and v_was_final > 0 and v_was_junior > 0,
    'the 400s graduate and everyone else moves up — counted before the promotion, not after'
  );

  perform assert_true(
    (select level from students where id = v_tunde) = 400,
    'a 300-level student is now 400 level'
  );

  perform assert_true(
    (select status from students where id = v_chidera) = 'graduating'
      and (select level from students where id = v_chidera) = 400,
    'a 400-level student graduates rather than being promoted to a level that does not exist'
  );

  perform assert_true(
    (select is_active from academic_sessions where id = v_next)
      and not (select is_active from academic_sessions where id = v_session),
    'the new session becomes the current one in the same transaction'
  );

  perform assert_true(
    (select state from compliance_statuses
      where student_id = v_tunde and academic_session_id = v_next) = 'uncleared',
    'a continuing student starts the new session owing dues'
  );

  perform assert_true(
    (select students_promoted from level_rollovers
      where to_academic_session_id = v_next) = v_promoted,
    'the rollover is recorded with its counts'
  );

  begin
    perform run_level_rollover(v_next, v_admin, 'Running the very same rollover twice.');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform assert_true(v_ok, 'the same rollover cannot be run twice — the second run would promote everyone again');
end $$;



-- ---------------------------------------------------------------------------
-- A correction never lowers a score
--
-- Found by rehearsing the demo. Correcting a dispute on a lecture with no
-- checkpoint rows re-scored the student from an empty set of marks and took
-- them from 0.5 to 0. The HOD clicked "correct"; ending up with less than they
-- started with is the opposite of that instruction.
-- ---------------------------------------------------------------------------

do $$
declare
  v_hod     uuid := '33333333-3333-3333-3333-333333333302';
  v_lect    uuid := '33333333-3333-3333-3333-333333333301';
  v_venue   uuid := '22222222-2222-2222-2222-222222222201';
  v_course  uuid := '66666666-6666-6666-6666-666666666601';
  v_student uuid := '44444444-4444-4444-4444-444444444402';
  v_paper   uuid := gen_random_uuid();
  v_dispute uuid;
begin
  -- A lecture recorded from a paper register: a real score, and no checkpoints
  -- at all for a correction to accept.
  insert into session_instances (id, course_id, held_on, venue_id, type, status, checkpoint_mode, closed_at, created_by)
  -- 'pair', because a half mark is only meaningful against two checkpoints —
  -- enforce_single_checkpoint_scoring refuses 0.5 on a single-checkpoint
  -- lecture, which is the schema defending the rule rather than this test
  -- working around it.
  values (v_paper, v_course, date '2026-02-10', v_venue, 'makeup', 'closed', 'pair', now(), v_lect);

  insert into session_scores (student_id, session_instance_id, score, status, source, confirmed_at)
  values (v_student, v_paper, 0.5, 'confirmed', 'manually_entered', now());

  insert into attendance_disputes (student_id, session_instance_id, student_note)
  values (v_student, v_paper, 'I was there for the whole hour and signed the sheet.')
  returning id into v_dispute;

  perform resolve_dispute(v_dispute, v_hod, false, 'Lecturer confirms she was present for the whole lecture.');

  perform assert_true(
    (select score from session_scores
      where student_id = v_student and session_instance_id = v_paper) = 1.0,
    'correcting a dispute on a lecture with no checkpoints credits the whole lecture rather than scoring from nothing'
  );

  perform assert_true(
    (select (metadata->>'score_after')::numeric from audit_log
      where action = 'dispute.corrected' and target_id = v_dispute::text) = 1.0,
    'and the audit row carries the score it actually ended at'
  );
end $$;

do $$
declare
  v_hod     uuid := '33333333-3333-3333-3333-333333333302';
  v_lect    uuid := '33333333-3333-3333-3333-333333333301';
  v_venue   uuid := '22222222-2222-2222-2222-222222222201';
  v_course  uuid := '66666666-6666-6666-6666-666666666601';
  v_student uuid := '44444444-4444-4444-4444-444444444402';
  v_full    uuid := gen_random_uuid();
  v_cp      uuid := gen_random_uuid();
  v_dispute uuid;
begin
  -- The other half of the floor: checkpoints exist, but only one of a pair, so
  -- re-scoring would legitimately produce 0.5 against an existing 1.0.
  insert into session_instances (id, course_id, held_on, venue_id, type, status, checkpoint_mode, closed_at, created_by)
  values (v_full, v_course, date '2026-02-17', v_venue, 'makeup', 'closed', 'pair', now(), v_lect);

  insert into checkpoints (id, session_instance_id, index, token, expires_at, issued_by)
  values (v_cp, v_full, 1, '4417', now() + interval '1 hour', v_lect);

  insert into session_scores (student_id, session_instance_id, score, status, source, confirmed_at)
  values (v_student, v_full, 1.0, 'confirmed', 'manually_entered', now());

  insert into attendance_disputes (student_id, session_instance_id, student_note)
  values (v_student, v_full, 'The second checkpoint never appeared on my phone.')
  returning id into v_dispute;

  perform resolve_dispute(v_dispute, v_hod, false, 'Second checkpoint was never issued; not her fault.');

  perform assert_true(
    (select score from session_scores
      where student_id = v_student and session_instance_id = v_full) = 1.0,
    'a correction never docks a student — where re-scoring comes out lower, the recomputation is what is wrong'
  );
end $$;


-- ---------------------------------------------------------------------------
-- The advisory baseline
--
-- Computed, not typed in. The point of these assertions is the last one: the
-- prediction must never be able to reach the eligibility determination, and
-- a model swapped in behind this table must not change that.
-- ---------------------------------------------------------------------------

do $$
declare
  v_chidera uuid := '44444444-4444-4444-4444-444444444401';
  v_halima  uuid := '44444444-4444-4444-4444-444444444402';
  v_tunde   uuid := '44444444-4444-4444-4444-444444444403';
  v_cmp301  uuid := '66666666-6666-6666-6666-666666666601';
  v_mth205  uuid := '66666666-6666-6666-6666-666666666602';
  v_before  numeric;
  v_written integer;
  v_extra   uuid := gen_random_uuid();
begin
  v_written := compute_risk_predictions();
  perform assert_true(v_written > 0, 'the advisory baseline writes predictions from real attendance');

  -- Asserted as behaviour rather than as a number: earlier blocks in this
  -- suite change Halima's attendance, and a fixed figure here would break on
  -- that rather than on anything to do with the prediction.
  select predicted_pct into v_before
  from risk_predictions where student_id = v_halima and course_id = v_cmp301;

  perform assert_true(
    v_before = round(
      (select coalesce(sum(ss.score), 0) / count(si.id) * 100
       from session_instances si
       left join session_scores ss
         on ss.session_instance_id = si.id and ss.student_id = v_halima
       where si.course_id = v_cmp301 and si.status = 'closed'), 2),
    'the prediction is the student''s own rate carried forward, not a number from anywhere else'
  );

  -- And it moves with the attendance. A prediction that did not would be a
  -- constant wearing a percentage sign.
  insert into session_instances (id, course_id, held_on, venue_id, type, status, checkpoint_mode, closed_at, created_by)
  values (v_extra, v_cmp301, date '2026-03-03', '22222222-2222-2222-2222-222222222201',
          'makeup', 'closed', 'pair', now(), '33333333-3333-3333-3333-333333333301');

  insert into session_scores (student_id, session_instance_id, score, status, source)
  values (v_halima, v_extra, 1.0, 'provisional', 'digital');

  perform compute_risk_predictions();

  perform assert_true(
    (select predicted_pct from risk_predictions
      where student_id = v_halima and course_id = v_cmp301) > v_before,
    'attending one more lecture in full raises the prediction — it tracks behaviour rather than sitting still'
  );

  -- Chidera has attended CMP 301 but holds a 200-level carry-over she has never
  -- turned up to. Per course, so one does not hide the other.
  perform assert_true(
    (select predicted_pct from risk_predictions
      where student_id = v_chidera and course_id = v_mth205) = 0,
    'a carry-over nobody attends is predicted separately from the course they do attend'
  );

  perform assert_true(
    (select pattern from risk_predictions
      where student_id = v_chidera and course_id = v_mth205) = 'disengagement',
    'not turning up at all reads as disengagement'
  );

  perform assert_true(
    (select pattern from risk_predictions
      where student_id = v_tunde and course_id = v_mth205) is null,
    'a student who is not falling short carries no pattern — a label that explains nothing is noise'
  );

  -- The one that matters. A prediction is about the future; eligibility is a
  -- determination about the past, and the two must never be confused on a
  -- screen that decides who sits an exam.
  v_before := attendance_pct(v_halima, v_cmp301);

  update risk_predictions set predicted_pct = 99.99, pattern = null
  where student_id = v_halima and course_id = v_cmp301;

  perform assert_true(
    attendance_pct(v_halima, v_cmp301) = v_before,
    'rewriting a prediction moves no attendance percentage — the determination never consults it'
  );

  -- And recomputing is wholesale, so a stale row for a student who has since
  -- turned things around cannot survive.
  perform compute_risk_predictions();
  perform assert_true(
    (select predicted_pct from risk_predictions
      where student_id = v_halima and course_id = v_cmp301) < 99.99,
    'recomputing replaces stale predictions rather than leaving them beside the new ones'
  );
end $$;

-- ---------------------------------------------------------------------------
-- Security posture
--
-- These assert the SHAPE of the schema's defences rather than any one rule, so
-- that weakening them fails the suite instead of going unnoticed.
--
-- The one that matters most is the SECURITY DEFINER check. PostgREST publishes
-- every function in `public` as an RPC, and Supabase grants execute on them to
-- `authenticated` by default. Functions like `attendance_pct(student, course)`
-- take another student's id as an argument and are therefore callable by
-- anybody — they are safe ONLY because they are SECURITY INVOKER, so their
-- internal reads run under the caller's own RLS and return nothing. Adding
-- SECURITY DEFINER to one for convenience would silently turn it into a way to
-- read any student's record.
-- ---------------------------------------------------------------------------

select assert_true(
  not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  ),
  'every table has row-level security enabled'
);

do $$
declare
  v_leaky text;
begin
  select string_agg(p.proname, ', ')
    into v_leaky
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.prosecdef
    and has_function_privilege('authenticated', p.oid, 'execute')
    -- current_app_role takes no arguments, so it can only ever report the
    -- caller's own role. It has to be definer: the RLS policies call it, and
    -- reading `profiles` to answer would recurse through those same policies.
    and p.proname <> 'current_app_role';

  perform assert_true(
    v_leaky is null,
    'no user-callable function is SECURITY DEFINER — RLS is what scopes them, and it only works if they run as the caller'
  );
end $$;

do $$
declare
  v_exposed text;
begin
  -- Every authority action. Reachable from `authenticated` would mean a student
  -- could clear themselves, waive their own dues, or promote the department.
  select string_agg(p.proname, ', ')
    into v_exposed
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'clear_student', 'decide_waiver', 'resolve_dispute', 'open_grace_period',
      'revoke_grace_period', 'deactivate_student', 'reactivate_student',
      'resolve_registration_dispute', 'run_level_rollover', 'cancel_session',
      'schedule_makeup', 'reschedule_session', 'authorize_eligibility_list',
      'advance_compliance_states', 'write_audit', 'notify_enrolled',
      'resolve_session_score', 'enrol_in_core_courses'
    )
    and (
      has_function_privilege('authenticated', p.oid, 'execute')
      or has_function_privilege('anon', p.oid, 'execute')
    );

  perform assert_true(
    v_exposed is null,
    'no authority action is callable by a signed-in user — every one goes through the API, which checks the role'
  );
end $$;

select assert_true(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'venue_directory'
      and column_name not in ('id', 'name')
  ),
  'the venue directory carries names only — it bypasses the geo-fence policy, so it must expose nothing else'
);

-- The report /api/health reads. Running the full migration set and being told
-- something is missing would mean the report's own expectations have drifted
-- from the migrations, which is worse than no report.
select assert_true(
  (dept_flow_schema_report()->>'up_to_date')::boolean,
  'the schema report agrees this database is fully migrated'
);

select assert_true(
  not has_function_privilege('authenticated', 'dept_flow_schema_report()', 'execute'),
  'the schema report is service-role only — it is SECURITY DEFINER and reads the catalog'
);

-- And the proof that SECURITY INVOKER is doing the work: Chidera asking for
-- Halima's attendance gets zero, not Halima's real 26.92%.
set local role authenticated;
set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444401';

select assert_true(
  attendance_pct('44444444-4444-4444-4444-444444444402',
                 '66666666-6666-6666-6666-666666666601') = 0,
  'a student calling attendance_pct for another student gets nothing — the function is not the guard, RLS is'
);

reset role;


-- The readable result. Every row here is an assertion that held; a failure
-- would have aborted before reaching this point.
select seq as "#", 'ok' as result, what as assertion from assertion_log order by seq;

rollback;
