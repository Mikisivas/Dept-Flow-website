import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";
import { lagosToday } from "@/lib/format";

/**
 * Starting a lecture.
 *
 * The lecture row is created at the moment the lecturer starts it, not ahead of
 * time by a scheduler. A timetable entry says a class is *meant* to happen; a
 * `session_instances` row says one *did*, and that distinction is what keeps
 * cancelled and never-held lectures out of the attendance denominator.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "lecturer") {
    return NextResponse.json({ error: "Only a lecturer can start a session." }, { status: 403 });
  }

  let body: { timetableEntryId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const timetableEntryId = String(body.timetableEntryId ?? "");
  if (!timetableEntryId) {
    return NextResponse.json({ error: "Which class?" }, { status: 400 });
  }

  const db = createServiceClient();

  const { data: entry } = await db
    .from("timetable_entries")
    .select("id, course_id, venue_id, start_time, end_time, courses(lecturer_id)")
    .eq("id", timetableEntryId)
    .maybeSingle();

  if (!entry) {
    return NextResponse.json({ error: "That class isn't on your timetable." }, { status: 404 });
  }

  // The service role has bypassed RLS to read this, so ownership is checked
  // here explicitly. Every service-role write in this product does the check
  // the policy would have done.
  const course = Array.isArray(entry.courses) ? entry.courses[0] : entry.courses;
  if (!course || course.lecturer_id !== session.profileId) {
    return NextResponse.json({ error: "That isn't your course." }, { status: 403 });
  }

  const { date } = lagosToday();

  const { data: existing } = await db
    .from("session_instances")
    .select("id, status")
    .eq("timetable_entry_id", timetableEntryId)
    .eq("held_on", date)
    .maybeSingle();

  // Tapping "Start session" twice — on a phone, in a hall, over a slow
  // connection — must not produce two lectures on the same day.
  if (existing) {
    if (existing.status === "scheduled") {
      await db
        .from("session_instances")
        .update({ status: "open", opened_at: new Date().toISOString() })
        .eq("id", existing.id);
    }
    return NextResponse.json({ sessionInstanceId: existing.id });
  }

  const { data: created, error } = await db
    .from("session_instances")
    .insert({
      course_id: entry.course_id,
      timetable_entry_id: entry.id,
      held_on: date,
      scheduled_start: `${date}T${entry.start_time}+01:00`,
      scheduled_end: `${date}T${entry.end_time}+01:00`,
      venue_id: entry.venue_id,
      type: "recurring",
      status: "open",
      opened_at: new Date().toISOString(),
      created_by: session.profileId,
    })
    .select("id")
    .single();

  if (error || !created) {
    return NextResponse.json(
      { error: "Couldn't start the session. Try again." },
      { status: 503 },
    );
  }

  return NextResponse.json({ sessionInstanceId: created.id });
}
