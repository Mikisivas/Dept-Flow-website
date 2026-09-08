-- Dept-Flow — make a class happen today
--
-- The main seed puts CMP 301 on Tuesdays and MTH 205 on Thursdays, which is
-- faithful to a real timetable and useless on a Monday afternoon when you want
-- to walk the attendance path end to end.
--
-- This adds a CMP 301 slot on whatever weekday you run it, so "Today's classes"
-- on the lecturer screen has something in it. Safe to run repeatedly: it does
-- nothing if today's slot already exists.
--
-- Development only.

begin;

insert into timetable_entries (academic_session_id, course_id, day_of_week, start_time, end_time, venue_id)
select
  '11111111-1111-1111-1111-111111111111',
  '66666666-6666-6666-6666-666666666601',        -- CMP 301
  extract(dow from current_date)::integer,
  '10:00',
  '12:00',
  '22222222-2222-2222-2222-222222222201'         -- Lecture Theatre A
where not exists (
  select 1 from timetable_entries
  where course_id = '66666666-6666-6666-6666-666666666601'
    and day_of_week = extract(dow from current_date)::integer
);

commit;

-- ---------------------------------------------------------------------------
-- What will stop you is the registration gate, not where you are standing
-- ---------------------------------------------------------------------------
--
-- Nothing about location needs setting up. Attendance is trust-based: the
-- lecturer issues one short-lived code and the student types it in, and the
-- venue is a name on a timetable row and nothing more. The August 2026 revision
-- dropped venues.centre_lat, centre_lng and radius_m along with the fence, so
-- an instruction to move the fence to wherever you are sitting would now fail
-- on columns that do not exist.
--
-- The gate that will actually reject a submission is semester registration.
-- Past the deadline an unconfirmed student cannot log attendance for any
-- course, and the rejection says 'not_registered'. If you are walking the
-- attendance path and the code keeps bouncing, check that the student has a
-- confirmed course_registrations row for this session and semester before
-- suspecting the code.
--
-- Confirming late is not free, which is worth seeing at least once: the
-- backfill inserts an absence for every lecture held between the deadline and
-- the moment of confirmation.
