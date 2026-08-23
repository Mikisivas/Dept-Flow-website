import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * "What happens if I miss the next N lectures?"
 *
 * The arithmetic is not here. It is `attendance_what_if()` in the database,
 * which is the same expression the eligibility rule uses — a second copy of
 * that rule written in TypeScript is a second copy that will one day disagree
 * with the first, and the disagreement would surface as a student told they
 * were fine and then refused a permit.
 *
 * Whose attendance is being asked about comes from the session cookie. A
 * student cannot ask this question about anybody else.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "student") {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  let body: { courseId?: string; missNext?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const courseId = String(body.courseId ?? "");
  if (!courseId) return NextResponse.json({ error: "Which course?" }, { status: 400 });

  const missNext = Number.isFinite(Number(body.missNext)) ? Math.trunc(Number(body.missNext)) : 0;

  const db = createServiceClient();
  const { data, error } = await db.rpc("attendance_what_if", {
    p_student_id: session.profileId,
    p_course_id: courseId,
    p_miss_next: missNext,
  });

  if (error) {
    return NextResponse.json({ error: "We couldn't work that out." }, { status: 503 });
  }

  const row = Array.isArray(data) ? data[0] : data;

  return NextResponse.json({
    resultingPct: Number(row?.resulting_pct ?? 0),
    stillEligible: Boolean(row?.still_eligible),
    mustAttend: Number(row?.must_attend ?? 0),
    remaining: Number(row?.remaining ?? 0),
  });
}
