import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Ending a lecture, which is when it is scored.
 *
 * There used to be a branch here deciding whether the lecture was scored out of
 * one checkpoint or two, and demanding a written justification for the first.
 * A lecture now carries one code and is scored present-or-absent, so there is
 * no decision left to make and nothing for the lecturer to justify.
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

  const { data: code } = await db
    .from("checkpoints")
    .select("id")
    .eq("session_instance_id", id)
    .maybeSingle();

  if (!code) {
    return NextResponse.json(
      { error: "No code was issued, so there is nothing to score." },
      { status: 409 },
    );
  }

  const { error: closeError } = await db
    .from("session_instances")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("id", id);

  if (closeError) {
    return NextResponse.json({ error: "Couldn't end the session." }, { status: 503 });
  }

  // Dropped enrolments are excluded: a student who left the course is not
  // absent from it, and scoring them would put a zero into a denominator they
  // are no longer part of.
  const { data: enrolled } = await db
    .from("enrolments")
    .select("student_id")
    .eq("course_id", instance.course_id)
    .is("dropped_at", null);

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

  return NextResponse.json({
    scored: students.length - failed,
    // Surfaced rather than swallowed: a partially scored lecture is a thing the
    // HOD has to fix, and hiding it makes it undiscoverable.
    failed,
  });
}
