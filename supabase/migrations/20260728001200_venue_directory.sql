-- Dept-Flow — venue names without venue coordinates
--
-- `venues_admin_read` is correct and stays: a student who can read the fence
-- centre and radius knows exactly how far from the hall they can stand, which
-- defeats the geo-fence. But it also hides the venue *name*, and the name is
-- not a secret — it is printed on the timetable, said aloud in class, and has
-- to appear on the lecturer's session screen and the student's checkpoint
-- screen.
--
-- Splitting them is the fix. This view has no coordinate columns at all, so
-- "the fence is admin-only" survives a careless query as well as a careless
-- screen — the same reasoning as `my_attendance_marks`.

-- Deliberately NOT security_invoker. The view runs as its owner and so is not
-- filtered by venues' row policy; what protects the coordinates is that they
-- are not selectable here at any privilege level.
create view venue_directory as
  select id, name from venues;

grant select on venue_directory to authenticated;

comment on view venue_directory is
  'Venue id and name only. The geo-fence centre and radius stay admin-only on venues.';
