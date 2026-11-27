import { NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";
import { ok } from "@/lib/supabase/result";

/**
 * Issuing the attendance code.
 *
 * The code goes on a whiteboard in front of eighty people, so it is not a
 * secret and is not stored hashed. What keeps it honest is that it is
 * short-lived and never travels to a student's browser, only to the
 * lecturer's. Since the geo-fence was removed that is the entire mechanism —
 * which is an argument for a short window, not a long one.
 *
 * One code per lecture. A lapsed code can be ROTATED: the row is updated in
 * place, so a student who already answered stays answered — `attendance_marks`
 * is keyed on the code row, and re-issuing must not ask a hall that has already
 * been counted to type again.
 */

/** Long enough to write it up and for a hall to type it; short enough to matter. */
const WINDOW_SECONDS = 300;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await currentUser();
  if (!session || session.role !== "lecturer") {
    return NextResponse.json({ error: "Only a lecturer can issue a code." }, { status: 403 });
  }

  const { id } = await params;
  const db = createServiceClient();

  const { data: instance } = ok(await db
    .from("session_instances")
    .select("id, status, courses(lecturer_id)")
    .eq("id", id)
    .maybeSingle(), "instance");

  if (!instance) {
    return NextResponse.json({ error: "No such session." }, { status: 404 });
  }

  const course = Array.isArray(instance.courses) ? instance.courses[0] : instance.courses;
  if (!course || course.lecturer_id !== session.profileId) {
    return NextResponse.json({ error: "That isn't your session." }, { status: 403 });
  }

  if (instance.status !== "open") {
    return NextResponse.json(
      { error: "This session isn't open, so no code can be issued." },
      { status: 409 },
    );
  }

  const { data: existing } = ok(await db
    .from("checkpoints")
    .select("id, expires_at")
    .eq("session_instance_id", id)
    .maybeSingle(), "existing");

  // Never a second code while the first is still live: two valid codes on one
  // board is a student-support problem, not a feature.
  if (existing && Date.parse(existing.expires_at) > Date.now()) {
    return NextResponse.json(
      { error: "A code is still live. Wait for it to close before issuing another." },
      { status: 409 },
    );
  }

  const row = {
    session_instance_id: id,
    // randomInt, not Math.random: the code is public once it is on the board,
    // but it must not be predictable before it is.
    token: String(randomInt(0, 10_000)).padStart(4, "0"),
    expires_at: new Date(Date.now() + WINDOW_SECONDS * 1000).toISOString(),
    issued_by: session.profileId,
    issued_at: new Date().toISOString(),
  };

  const { data: created, error } = existing
    ? await db.from("checkpoints").update(row).eq("id", existing.id).select("token, expires_at").single()
    : await db.from("checkpoints").insert(row).select("token, expires_at").single();

  if (error || !created) {
    return NextResponse.json({ error: "Couldn't issue the code. Try again." }, { status: 503 });
  }

  return NextResponse.json({
    token: created.token,
    expiresAt: created.expires_at,
    reissued: Boolean(existing),
  });
}
