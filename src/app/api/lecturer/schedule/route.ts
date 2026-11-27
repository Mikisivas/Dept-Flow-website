import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Cancelling a lecture, and scheduling a makeup.
 *
 * Both notify every enrolled student, and both do it from inside the database
 * function rather than here — so the promise the screen makes cannot be broken
 * by a caller that forgets the second half.
 */

const CANCEL_MESSAGES: Record<string, string> = {
  not_your_course: "That isn't your course.",
  already_cancelled: "That lecture is already cancelled.",
  already_held: "That lecture has already been held. Cancelling it now would change the attendance of everyone who came.",
  in_progress: "That lecture is open right now. End it first.",
  not_found: "That lecture isn't on your timetable.",
};

const RESCHEDULE_MESSAGES: Record<string, string> = {
  not_your_course: "That isn't your course.",
  no_such_venue: "Choose a venue from the list.",
  already_held: "That lecture has already been held, so it cannot be moved.",
  in_progress: "That lecture is open right now. End it first.",
  already_scheduled: "That course already has a lecture on the day you're moving it to.",
  not_found: "That lecture isn't on your timetable.",
};

const MAKEUP_MESSAGES: Record<string, string> = {
  not_your_course: "That isn't your course.",
  no_such_venue: "Choose a venue from the list.",
  already_scheduled: "That course already has a lecture on that day.",
  not_found: "That course no longer exists.",
};

export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "lecturer") {
    return NextResponse.json(
      { error: "Only a lecturer can change their schedule." },
      { status: 403 },
    );
  }

  let body: {
    action?: "cancel" | "makeup" | "reschedule";
    courseId?: string;
    timetableEntryId?: string | null;
    heldOn?: string;
    movedTo?: string;
    startsAt?: string;
    endsAt?: string;
    venueId?: string;
    reason?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const db = createServiceClient();

  if (body.action === "makeup") {
    const { data, error } = await db.rpc("schedule_makeup", {
      p_course_id: String(body.courseId ?? ""),
      p_held_on: String(body.heldOn ?? ""),
      p_starts: String(body.startsAt ?? ""),
      p_ends: String(body.endsAt ?? ""),
      p_venue_id: String(body.venueId ?? ""),
      p_actor_id: session.profileId,
      p_note: String(body.reason ?? "").trim() || null,
    });
    return translate(data, error, MAKEUP_MESSAGES);
  }

  if (body.action === "reschedule") {
    const { data, error } = await db.rpc("reschedule_session", {
      p_course_id: String(body.courseId ?? ""),
      p_timetable_entry_id: body.timetableEntryId ? String(body.timetableEntryId) : null,
      p_from: String(body.heldOn ?? ""),
      p_to: String(body.movedTo ?? ""),
      p_starts: String(body.startsAt ?? ""),
      p_ends: String(body.endsAt ?? ""),
      p_venue_id: String(body.venueId ?? ""),
      p_actor_id: session.profileId,
      p_reason: String(body.reason ?? "").trim(),
    });
    return translate(data, error, RESCHEDULE_MESSAGES);
  }

  const { data, error } = await db.rpc("cancel_session", {
    p_course_id: String(body.courseId ?? ""),
    p_timetable_entry_id: body.timetableEntryId ? String(body.timetableEntryId) : null,
    p_held_on: String(body.heldOn ?? ""),
    p_actor_id: session.profileId,
    p_reason: String(body.reason ?? "").trim(),
  });
  return translate(data, error, CANCEL_MESSAGES);
}

function translate(
  data: unknown,
  error: { message: string } | null,
  messages: Record<string, string>,
) {
  if (error) {
    const cleaned = error.message.replace(/^.*?:\s*/, "").trim();
    return NextResponse.json(
      { error: cleaned.charAt(0).toUpperCase() + cleaned.slice(1) },
      { status: 400 },
    );
  }

  const refusal = messages[String(data)];
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });

  return NextResponse.json({ ok: true, outcome: data });
}
