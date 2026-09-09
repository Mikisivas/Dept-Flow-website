-- Dept-Flow — local development seed
--
-- Mirrors the people and courses in the design mockups, with the department's
-- real prefix: Computer Science is CMP.
--
-- Local development only.
--
-- Note there is no auth.users here. Dept-Flow does not use Supabase Auth: a
-- student is identified by their matric number and staff by a staff ID, and
-- neither fits GoTrue's email-or-phone account model. Credentials live on
-- `profiles` and the API issues its own JWT. See docs/decisions.md.
--
-- Every seeded account logs in with the password "demo-password", hashed here
-- by pgcrypto. A development convenience that must never reach a deployment.

begin;

-- ---------------------------------------------------------------------------
-- This is a fresh-install script
-- ---------------------------------------------------------------------------

-- Running it twice used to fail on a primary-key violation several hundred
-- lines in, which says nothing about what to do next. It also creates thirteen
-- lectures from a loop, so "just add on conflict do nothing" would quietly
-- produce twenty-six.
do $$
begin
  if exists (select 1 from academic_sessions
              where id = '11111111-1111-1111-1111-111111111111') then
    raise exception
      'This project is already seeded. To add columns from a later migration to existing data, run supabase/backfill_course_registration.sql instead. To start over, drop and recreate the schema first.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Academic session, venues, dues
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Everything below is dated RELATIVE TO TODAY
-- ---------------------------------------------------------------------------
--
-- This seed used to carry absolute dates, and it rotted: written during a
-- session that was in progress, it described a session that had ENDED by the
-- time anyone ran it again. That was survivable while the product reported the
-- past. It is not survivable now — a forecast needs lectures still to come, and
-- against a finished session every projection collapses to the current
-- percentage. The demo would show a warning system that never warns anybody,
-- which is precisely the failure the rebuild exists to fix.
--
-- So: the session started thirteen weeks ago and runs for seventeen more.
-- Thirteen weeks is enough for the trend to mean something, and seventeen
-- ahead is enough that a student who has stopped attending is genuinely
-- projected to fail rather than merely reported as behind.
insert into academic_sessions (id, name, starts_on, ends_on, is_active) values
  (
    '11111111-1111-1111-1111-111111111111',
    to_char(current_date - 91, 'YYYY') || '/' || to_char(current_date + 119, 'YYYY'),
    current_date - 91,
    current_date + 119,
    true
  );

insert into venues (id, name) values
  ('22222222-2222-2222-2222-222222222201', 'Lecture Theatre A'),
  ('22222222-2222-2222-2222-222222222202', 'Maths Block 2');

-- ₦5,000 = 500000 kobo.
insert into dues_periods (academic_session_id, resumption_date, dues_amount_kobo) values
  ('11111111-1111-1111-1111-111111111111', current_date - 91, 500000);

-- Seven days from resumption, which is what the department actually allows.
-- The window is what makes the deadline in the gate a real date rather than a
-- policy nobody configured — with no row here, attendance is ungated and
-- confirm_registration() has nothing to backfill from.
insert into registration_periods (academic_session_id, semester, opens_on, closes_on) values
  ('11111111-1111-1111-1111-111111111111', 1, current_date - 91, current_date - 84);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

-- Passwords are hashed here by pgcrypto so the seed needs no external tooling.
-- The API hashes with Argon2id; the credential constraint accepts both.
insert into profiles (id, role, surname, first_name, other_names, phone, staff_id) values
  ('33333333-3333-3333-3333-333333333301', 'lecturer', 'Bello',   'Amina',   'Kemi',  '+2348030000001', 'STF/CMP/014'),
  ('33333333-3333-3333-3333-333333333302', 'hod',      'Eze',     'Nnamdi',   null,   '+2348030000002', 'STF/CMP/001'),
  ('33333333-3333-3333-3333-333333333303', 'admin',    'Yusuf',   'Ibrahim',  null,   '+2348030000003', 'STF/ADM/007'),
  ('44444444-4444-4444-4444-444444444401', 'student',  'Okonkwo', 'Chidera', 'Emeka', '+2348050000001', null),
  ('44444444-4444-4444-4444-444444444402', 'student',  'Sanusi',  'Halima',   null,   '+2348050000002', null),
  ('44444444-4444-4444-4444-444444444403', 'student',  'Adeyemi', 'Tunde',   'Ola',   '+2348050000003', null);

-- Every seeded account logs in with "demo-password". Development only.
update profiles
   set password_hash = crypt('demo-password', gen_salt('bf', 10)),
       password_updated_at = now();

insert into whitelist_entries (id, academic_session_id, matric_no, surname, level, claimed, claimed_by, claimed_at) values
  ('55555555-5555-5555-5555-555555555501', '11111111-1111-1111-1111-111111111111', 'CMP/2021/047', 'Okonkwo', 400, false, null, null),
  ('55555555-5555-5555-5555-555555555502', '11111111-1111-1111-1111-111111111111', 'CMP/2021/112', 'Sanusi',  400, false, null, null),
  ('55555555-5555-5555-5555-555555555503', '11111111-1111-1111-1111-111111111111', 'MTH/2022/018', 'Adeyemi', 300, false, null, null),
  ('55555555-5555-5555-5555-555555555504', '11111111-1111-1111-1111-111111111111', 'STA/2022/091', 'Bassey',  300, false, null, null);

insert into students (id, matric_no, level, whitelist_entry_id) values
  ('44444444-4444-4444-4444-444444444401', 'CMP/2021/047', 400, '55555555-5555-5555-5555-555555555501'),
  ('44444444-4444-4444-4444-444444444402', 'CMP/2021/112', 400, '55555555-5555-5555-5555-555555555502'),
  ('44444444-4444-4444-4444-444444444403', 'MTH/2022/018', 300, '55555555-5555-5555-5555-555555555503');

update whitelist_entries w
   set claimed = true, claimed_by = id_map.student_id, claimed_at = now()
  from (values
    ('55555555-5555-5555-5555-555555555501'::uuid, '44444444-4444-4444-4444-444444444401'::uuid),
    ('55555555-5555-5555-5555-555555555502'::uuid, '44444444-4444-4444-4444-444444444402'::uuid),
    ('55555555-5555-5555-5555-555555555503'::uuid, '44444444-4444-4444-4444-444444444403'::uuid)
  ) as id_map(whitelist_id, student_id)
 where w.id = id_map.whitelist_id;

-- ---------------------------------------------------------------------------
-- Courses and enrolment
-- ---------------------------------------------------------------------------

-- CMP 301 is core at 300 level; STA 202 is an elective at 200; MTH 205 is core
-- at 200 and so is a carry-over for anyone above that level.
insert into courses (id, academic_session_id, code, title, level, kind, credit_units, semester, lecturer_id) values
  ('66666666-6666-6666-6666-666666666601', '11111111-1111-1111-1111-111111111111', 'CMP 301', 'Operating Systems', 300, 'core',     3, 1, '33333333-3333-3333-3333-333333333301'),
  ('66666666-6666-6666-6666-666666666602', '11111111-1111-1111-1111-111111111111', 'MTH 205', 'Linear Algebra',    200, 'core',     3, 1, '33333333-3333-3333-3333-333333333301'),
  ('66666666-6666-6666-6666-666666666603', '11111111-1111-1111-1111-111111111111', 'STA 202', 'Probability II',    200, 'elective', 2, 1, '33333333-3333-3333-3333-333333333301');

-- enrolled_on is the session start, not today. The attendance denominator
-- counts lectures held from the join date, so leaving this at the default
-- would put all thirteen seeded CMP 301 lectures before every student's
-- enrolment and give the whole cohort a denominator of zero.
insert into enrolments (student_id, course_id, source, enrolled_on)
select s.id, c.id, m.source::enrolment_source, current_date - 91
from students s
cross join courses c
join (values
  ('CMP/2021/047', 'CMP 301', 'core'),
  ('CMP/2021/047', 'MTH 205', 'carry_over'),
  ('CMP/2021/047', 'STA 202', 'elective'),
  ('CMP/2021/112', 'CMP 301', 'core'),
  ('CMP/2021/112', 'STA 202', 'elective'),
  ('MTH/2022/018', 'MTH 205', 'carry_over')
) as m(matric_no, code, source)
  on m.matric_no = s.matric_no and m.code = c.code;

insert into timetable_entries (id, academic_session_id, course_id, day_of_week, start_time, end_time, venue_id) values
  ('77777777-7777-7777-7777-777777777701', '11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666601', 2, '10:00', '12:00', '22222222-2222-2222-2222-222222222201'),
  ('77777777-7777-7777-7777-777777777702', '11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666602', 4, '08:00', '10:00', '22222222-2222-2222-2222-222222222202');

-- ---------------------------------------------------------------------------
-- Compliance starting positions
-- ---------------------------------------------------------------------------

-- Chidera has not paid. Her attendance counts anyway — that is the decoupling
-- — and what it costs her is the exam permit, which needs the dues cleared as
-- well as the 75%. Halima has paid in full and can print hers. Tunde is locked
-- out after the buffer expired. Between them the three cover every branch of
-- the permit screen, which is the point of seeding them differently.
insert into compliance_statuses (student_id, academic_session_id, state, cleared_at, cleared_via, locked_at) values
  ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111111', 'uncleared', null,  null,      null),
  ('44444444-4444-4444-4444-444444444402', '11111111-1111-1111-1111-111111111111', 'cleared',   now(), 'payment', null),
  ('44444444-4444-4444-4444-444444444403', '11111111-1111-1111-1111-111111111111', 'locked',    null,  null,      now());

insert into payments (student_id, academic_session_id, paystack_reference, channel, status, amount_kobo, verified_at) values
  ('44444444-4444-4444-4444-444444444402', '11111111-1111-1111-1111-111111111111', 'DF-TEST-000112', 'transfer', 'success', 500000, now());

-- ---------------------------------------------------------------------------
-- A term of CMP 301, scored
-- ---------------------------------------------------------------------------

-- Thirteen closed lectures. Attendance is present-or-absent now, so the
-- pattern worth seeding is not a mixture of half marks but a TREND.
--
-- Chidera is the case the whole warning system exists for: ten lectures
-- straight, then three misses running. Her running percentage is 76.92%, which
-- is ABOVE the line — a scoreboard would show her green and say nothing. Where
-- she is heading is not above the line, and that is the difference between
-- reporting and warning.
do $$
declare
  v_course  uuid := '66666666-6666-6666-6666-666666666601';
  v_venue   uuid := '22222222-2222-2222-2222-222222222201';
  v_tt      uuid := '77777777-7777-7777-7777-777777777701';
  v_lect    uuid := '33333333-3333-3333-3333-333333333301';
  v_chidera uuid := '44444444-4444-4444-4444-444444444401';
  v_halima  uuid := '44444444-4444-4444-4444-444444444402';
  v_session uuid;
  v_day     date;
  i         integer;
  -- Chidera: ten straight, then three misses running. 10 of 13 = 76.92%.
  chidera_scores numeric[] := array[1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0, 0, 0];
  -- Halima: never established a habit. 5 of 13 = 38.46%.
  halima_scores  numeric[] := array[1.0, 0, 0, 1.0, 0, 0, 1.0, 0, 1.0, 0, 0, 1.0, 0];
begin
  for i in 1..13 loop
    v_day := (current_date - 90) + (7 * (i - 1));
    v_session := gen_random_uuid();

    insert into session_instances (
      id, course_id, timetable_entry_id, held_on, venue_id, type, status,
      opened_at, closed_at, created_by
    ) values (
      v_session, v_course, v_tt, v_day, v_venue, 'recurring', 'closed',
      v_day + time '10:00', v_day + time '12:00', v_lect
    );

    insert into session_scores (student_id, session_instance_id, score)
    values (v_chidera, v_session, chidera_scores[i]);

    insert into session_scores (student_id, session_instance_id, score)
    values (v_halima, v_session, halima_scores[i]);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Enough for every screen to have something on it
-- ---------------------------------------------------------------------------

-- Five screens were reachable but empty against this seed: attendance disputes,
-- registration disputes, notifications, the audit log, and the lecturer's third
-- course. An empty screen and an unbuilt screen look identical, which is the
-- wrong impression for a demo to give.
--
-- Nothing here is padding. Each row is a case the product exists to handle.

-- STA 202 had no weekly slot, so its lecturer could not start a lecture on it
-- at all — "Start session" reads from the timetable.
insert into timetable_entries (id, academic_session_id, course_id, day_of_week, start_time, end_time, venue_id)
values (
  '77777777-7777-7777-7777-777777777703',
  '11111111-1111-1111-1111-111111111111',
  '66666666-6666-6666-6666-666666666603',
  3, '15:00', '17:00',
  '22222222-2222-2222-2222-222222222202'
);

-- Halima was marked outside the hall on the lecture of 4 November. Her mark on
-- that session is the rejection the dispute is about, so correcting it has
-- something real to re-score.
insert into attendance_disputes (student_id, session_instance_id, student_note)
select
  '44444444-4444-4444-4444-444444444402',
  si.id,
  'I was in the back row of the hall for the whole lecture but it said I was outside.'
from session_instances si
where si.course_id = '66666666-6666-6666-6666-666666666601'
order by si.held_on
offset 6 limit 1;

-- Somebody reports that their matric number was registered by another person.
insert into registration_disputes (matric_no, academic_session_id, reporter_phone)
values ('CMP/2021/241', '11111111-1111-1111-1111-111111111111', '+2348037654321');

-- What the students would already have been told.
insert into notifications (recipient_id, kind, title, body, link) values
  ('44444444-4444-4444-4444-444444444401', 'payment_reminder',
   'Your attendance is recorded but not counted',
   'Ten sessions are waiting on your dues. Clearing counts all of them at once.',
   '/dues'),
  ('44444444-4444-4444-4444-444444444403', 'payment_reminder',
   'Attendance recording has stopped for your account',
   'The payment window closed on day 30. Speak to the department office about a grace period.',
   '/dues'),
  ('44444444-4444-4444-4444-444444444402', 'payment_confirmed',
   'Dues cleared',
   'Every session you had recorded is now counted towards the 75% threshold.',
   '/dashboard');

-- A short history, so the audit log demonstrates what it is for rather than
-- sitting empty. Written through write_audit, so these are ordinary rows and
-- the immutability trigger governs them exactly as it governs new ones.
select write_audit(
  '33333333-3333-3333-3333-333333333301', 'lecturer', 'manual_batch.submit',
  'session_instances', (select id::text from session_instances
                        where course_id = '66666666-6666-6666-6666-666666666601'
                        order by held_on offset 2 limit 1),
  'Network was down in Lecture Theatre A for the whole hour; register taken on paper.',
  jsonb_build_object('row_count', 61)
);

select write_audit(
  '33333333-3333-3333-3333-333333333303', 'admin', 'payment.reconciled',
  'payments', null,
  'Nightly reconciliation: two transactions re-verified against Paystack.',
  jsonb_build_object('checked', 2, 'settled', 1)
);

-- ---------------------------------------------------------------------------
-- Tunde's MTH 205, a student sitting exactly on the line
-- ---------------------------------------------------------------------------

-- He has never paid, which since payment was decoupled affects his standing
-- with the department and not his attendance. Both facts are true at once, and
-- the permit is the one screen where they meet.
--
-- 6 of 8 is 75.00% — exactly the threshold, which makes him the case worth
-- demonstrating: the attendance half of his permit passes on the boundary while
-- the dues half does not, so the panel has to say precisely what is outstanding
-- rather than a flat no. It used to be 4.5 of 6, which said the same thing back
-- when a lecture could be half attended.
do $$
declare
  v_tunde  uuid := '44444444-4444-4444-4444-444444444403';
  v_mth205 uuid := '66666666-6666-6666-6666-666666666602';
  v_entry  uuid := '77777777-7777-7777-7777-777777777702';
  v_venue  uuid := '22222222-2222-2222-2222-222222222202';
  v_lect   uuid := '33333333-3333-3333-3333-333333333301';
  v_marks  numeric[] := array[1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0];
  v_day    date;
  v_id     uuid;
  i        integer;
begin
  for i in 1..8 loop
    v_day := (current_date - 81) + ((i - 1) * 7);
    v_id  := gen_random_uuid();

    insert into session_instances (
      id, course_id, timetable_entry_id, held_on, scheduled_start, scheduled_end,
      venue_id, type, status, closed_at, created_by
    )
    values (
      v_id, v_mth205, v_entry, v_day,
      (v_day + time '08:00') at time zone 'Africa/Lagos',
      (v_day + time '10:00') at time zone 'Africa/Lagos',
      v_venue, 'recurring', 'closed', now(), v_lect
    );

    -- A zero is an absence, and an absence is the lack of a row rather than a
    -- row saying nothing — the same way the rest of this schema treats it.
    if v_marks[i] > 0 then
      insert into session_scores (student_id, session_instance_id, score, source)
      values (v_tunde, v_id, v_marks[i], 'digital');
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Advisory risk signals
-- ---------------------------------------------------------------------------

-- Second-order only. The HOD's at-risk list reads these; the authoritative
-- eligibility determination never does.
--
-- Computed rather than written out. These used to be two numbers typed in by
-- hand, which meant the at-risk list showed figures with no relationship to the
-- attendance beside them — and which would not have moved if a student's did.
--
-- ---------------------------------------------------------------------------
-- Registration, confirmed
-- ---------------------------------------------------------------------------

-- All three registered inside the window. Written directly rather than through
-- confirm_registration(), because the seed is describing history: these were
-- confirmed in September, and calling the function would stamp them now and
-- backfill an absence for every lecture of the term.
--
-- The late path and the HOD's individual exception are exercised in the schema
-- tests instead, against students created for it. Seeding a permanently
-- shut-out student would leave every screen in the demo showing an error state
-- somebody has to explain.
insert into course_registrations (student_id, academic_session_id, semester, status, registered_at)
values
  ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111111', 1,
   'confirmed', (current_date - 88)::timestamptz + interval '9 hours 14 minutes'),
  ('44444444-4444-4444-4444-444444444402', '11111111-1111-1111-1111-111111111111', 1,
   'confirmed', (current_date - 87)::timestamptz + interval '16 hours 2 minutes'),
  ('44444444-4444-4444-4444-444444444403', '11111111-1111-1111-1111-111111111111', 1,
   'confirmed', (current_date - 84)::timestamptz + interval '23 hours 11 minutes');

-- Last in the file, and it has to be: it reads every lecture and every mark, so
-- running it before the sections above would predict from half a term.
-- ---------------------------------------------------------------------------
-- One student on a data-only WhatsApp SIM
-- ---------------------------------------------------------------------------

-- The uncommon case, seeded because it is the one that breaks: a Critical
-- warning for Halima has to reach 0805… by WhatsApp and 0803… by SMS, and a
-- demo where every student has one number never exercises that at all.
update profiles
   set whatsapp_phone = '+2348051111111',
       whatsapp_verified_at = (current_date - 87)::timestamptz + interval '16 hours 4 minutes',
       phone_verified_at = (current_date - 87)::timestamptz + interval '16 hours 2 minutes'
 where id = '44444444-4444-4444-4444-444444444402';

update profiles
   set phone_verified_at = created_at
 where role = 'student' and phone_verified_at is null;

select compute_risk_predictions();

commit;
