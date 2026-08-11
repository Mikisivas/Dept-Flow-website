import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Allocating a student's permit reference.
 *
 * `issue_exam_permit` is idempotent: one reference per student per session,
 * allocated once. Re-issuing on every download would make every previously
 * printed copy unverifiable, which is the opposite of what a reference is for.
 *
 * It returns null when no authorized eligibility list marks the student
 * eligible for anything — before the department has decided, there is no
 * permit to issue.
 */
export async function POST() {
  const session = await currentUser();
  if (!session || session.role !== "student") {
    return NextResponse.json({ error: "Only a student has an exam permit." }, { status: 403 });
  }

  const db = createServiceClient();

  const { data: active } = await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();

  if (!active) {
    return NextResponse.json({ error: "There is no active session." }, { status: 409 });
  }

  const { data, error } = await db.rpc("issue_exam_permit", {
    p_student_id: session.profileId,
    p_academic_session_id: active.id,
  });

  if (error) {
    return NextResponse.json({ error: "Could not issue your permit." }, { status: 400 });
  }

  if (!data) {
    return NextResponse.json(
      {
        error:
          "No permit yet — the eligibility list for your courses has not been authorized, or it does not clear you for any paper.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, reference: data });
}
