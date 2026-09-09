import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { confirmRegistration } from "@/lib/data/courses";
import { createServiceClient } from "@/lib/supabase/client";
import { ok } from "@/lib/supabase/result";

/**
 * A student ending their registration for a semester.
 *
 * The one thing this route must not do is take a time from the client. The
 * backfill window runs from the deadline to the moment of confirmation, so a
 * caller who could supply that moment could erase their own absences. It is
 * stamped inside `confirm_registration()` and nowhere else — this route sends
 * a student, a session and a semester, and nothing that looks like a clock.
 *
 * Which semester is taken from the body because the screen has a switcher and
 * a student can be looking at either; which STUDENT is taken from the session
 * cookie and never from the body.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "student") {
    return NextResponse.json({ error: "Sign in to confirm your registration." }, { status: 401 });
  }

  let body: { semester?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const semester = Number(body.semester);
  if (semester !== 1 && semester !== 2) {
    return NextResponse.json({ error: "Which semester?" }, { status: 400 });
  }

  const db = createServiceClient();
  const { data: academicSession } = ok(await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .maybeSingle(), "academicSession");

  if (!academicSession) {
    return NextResponse.json(
      { error: "No academic session is active, so there is nothing to register for." },
      { status: 409 },
    );
  }

  try {
    const result = await confirmRegistration(session.profileId, academicSession.id, semester);

    // 200 for every one of these: the server understood and decided. "You have
    // no courses yet" is an answer, not a failure, and the screen shows it as
    // one.
    return NextResponse.json({
      ok: result.status === "confirmed" || result.status === "confirmed_late",
      ...result,
    });
  } catch (error) {
    console.error("registration confirmation failed", error);
    return NextResponse.json(
      { ok: false, error: "We couldn't confirm that. Try again." },
      { status: 503 },
    );
  }
}
