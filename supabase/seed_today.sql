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
-- The geo-fence will reject you unless you are standing in Yaba
-- ---------------------------------------------------------------------------
--
-- 'Lecture Theatre A' is seeded at 6.5183, 3.3768 with a 40 m radius, because
-- that is a real place. Submitting from anywhere else is correctly rejected as
-- "You're not in the lecture hall" — the fence is working, not broken.
--
-- To test the accept path, move the fence to wherever you are. In the browser
-- console on any page of the site:
--
--   navigator.geolocation.getCurrentPosition(p => console.log(p.coords.latitude, p.coords.longitude))
--
-- then run this with those two numbers, and put it back afterwards:
--
--   update venues
--      set centre_lat = <your latitude>,
--          centre_lng = <your longitude>
--    where name = 'Lecture Theatre A';
--
-- The radius is constrained to 30–50 m by the schema and should stay there:
-- widening it to make a test pass is how a geo-fence becomes decorative.
