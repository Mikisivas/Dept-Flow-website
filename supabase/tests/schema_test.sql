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

-- The readable result. Every row here is an assertion that held; a failure
-- would have aborted before reaching this point.
select seq as "#", 'ok' as result, what as assertion from assertion_log order by seq;

rollback;
