import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { addCourse, dropCourse, REGISTRATION_MESSAGES } from "@/lib/data/courses";

/**
 * A student registering for, or removing, an optional course.
 *
 * Whose registration it is comes from the session cookie. Every rule about
 * what may be added — level, kind, the credit cap, whether it is already held —
 * is enforced by the database function, not here, so a request that skips this
 * screen meets the same answers.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "student") {
    return NextResponse.json({ error: "Sign in to change your courses." }, { status: 401 });
  }

  let body: { courseId?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const courseId = String(body.courseId ?? "");
  if (!courseId) return NextResponse.json({ error: "Which course?" }, { status: 400 });

  try {
    const outcome =
      body.action === "drop"
        ? await dropCourse(session.profileId, courseId)
        : await addCourse(session.profileId, courseId);

    const message = REGISTRATION_MESSAGES[outcome] ?? outcome;
    const ok = outcome === "added" || outcome === "dropped";

    // 200 either way: the server understood and decided. "Over the credit
    // limit" is an answer, not a failure, and the screen shows it as one.
    return NextResponse.json({ ok, outcome, message });
  } catch (error) {
    console.error("course registration failed", error);
    return NextResponse.json(
      { ok: false, message: "We couldn't save that. Try again." },
      { status: 503 },
    );
  }
}
