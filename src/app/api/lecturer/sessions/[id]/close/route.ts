import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Ending a lecture, which is when it is scored.
 *
 * `resolve_session_score()` in the database is the authoritative implementation
 * and this route does not reimplement any of it — it closes the lecture, then
 * calls the function once per enrolled student. Absent students are scored too:
 * a lecture only counts against you if the system knows you were meant to be
 * there, and a missing row would silently forgive it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await currentUser();
  if (!session || session.role !== "lecturer") {
    return NextResponse.json({ error: "Only a lecturer can end a session." }, { status: 403 });
  }

  const { id } = await params;

  let body: { reason?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const db = createServiceClient();

  const { data: instance } = await db
    .from("session_instances")
    .select("id, course_id, status, courses(lecturer_id)")
    .eq("id", id)
    .maybeSingle();

  if (!instance) return NextResponse.json({ error: "No such session." }, { status: 404 });

  const course = Array.isArray(instance.courses) ? instance.courses[0] : instance.courses;
  if (!course || course.lecturer_id !== session.profileId) {
    return NextResponse.json({ error: "That isn't your session." }, { status: 403 });
  }

  if (instance.status === "closed") {
    return NextResponse.json({ alreadyClosed: true, scored: 0 });
  }

  const { data: checkpoints } = await db
    .from("checkpoints")
    .select("index")
    .eq("session_instance_id", id);

  const issued = (checkpoints ?? []).length;
  if (issued === 0) {
    return NextResponse.json(
      { error: "No checkpoint was issued, so there is nothing to score." },
      { status: 409 },
    );
  }

  // How the lecture is scored is decided by what actually happened, not by what
  // was intended: one token means present-or-absent, two means half marks are
  // possible. This is why the column is null until now.
  const mode = issued >= 2 ? "pair" : "single";
  const reason = String(body.reason ?? "").trim();

  if (mode === "single" && reason.length < 10) {
    return NextResponse.json(
      { error: "Say why only one checkpoint was issued. The HOD reviews these." },
      { status: 400 },
    );
  }

  const { error: closeError } = await db
    .from("session_instances")
    .update({
      status: "closed",
      checkpoint_mode: mode,
      closed_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (closeError) {
    return NextResponse.json({ error: "Couldn't end the session." }, { status: 503 });
  }

  const { data: enrolled } = await db
    .from("enrolments")
    .select("student_id")
    .eq("course_id", instance.course_id);

  const students = (enrolled ?? []).map((row) => row.student_id);

  const results = await Promise.all(
    students.map((studentId) =>
      db.rpc("resolve_session_score", {
        p_student_id: studentId,
        p_session_instance_id: id,
        p_source: "digital",
        p_manual_batch_id: null,
      }),
    ),
  );

  const failed = results.filter((r) => r.error).length;

  // A single-checkpoint lecture changes how every student in the hall is
  // scored, so it leaves a record with a name and a reason against it.
  if (mode === "single") {
    await db.rpc("write_audit", {
      p_actor_id: session.profileId,
      p_actor_role: "lecturer",
      p_action: "session.closed_single_checkpoint",
      p_target_table: "session_instances",
      p_target_id: id,
      p_reason: reason,
      p_metadata: { course_id: instance.course_id, students_scored: students.length - failed },
    });
  }

  return NextResponse.json({
    mode,
    scored: students.length - failed,
    // Surfaced rather than swallowed: a partially scored lecture is a thing the
    // HOD has to fix, and hiding it makes it undiscoverable.
    failed,
  });
}
