import { NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Issuing a checkpoint code.
 *
 * The code goes on a whiteboard in front of eighty people, so it is not a
 * secret and is not stored hashed. What makes it hard to fake is that it is
 * short-lived and paired with a geo-fence — and that it never travels to a
 * student's browser, only to the lecturer's.
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

  const { data: instance } = await db
    .from("session_instances")
    .select("id, status, courses(lecturer_id)")
    .eq("id", id)
    .maybeSingle();

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

  const { data: issued } = await db
    .from("checkpoints")
    .select("index, expires_at")
    .eq("session_instance_id", id)
    .order("index");

  const existing = issued ?? [];

  // Two per lecture, and never a second one while the first is still live —
  // two valid codes on a board at once is a student support problem, not a
  // feature.
  if (existing.length >= 2) {
    return NextResponse.json(
      { error: "Both checkpoints have been issued." },
      { status: 409 },
    );
  }
  if (existing.some((cp) => Date.parse(cp.expires_at) > Date.now())) {
    return NextResponse.json(
      { error: "A checkpoint is still open. Wait for it to close." },
      { status: 409 },
    );
  }

  const index = existing.length + 1;
  const expiresAt = new Date(Date.now() + WINDOW_SECONDS * 1000).toISOString();

  const { data: created, error } = await db
    .from("checkpoints")
    .insert({
      session_instance_id: id,
      index,
      // randomInt, not Math.random: the code is public once it is on the board,
      // but it must not be predictable before it is.
      token: String(randomInt(0, 10_000)).padStart(4, "0"),
      expires_at: expiresAt,
      issued_by: session.profileId,
    })
    .select("index, token, expires_at")
    .single();

  if (error || !created) {
    return NextResponse.json({ error: "Couldn't issue the code. Try again." }, { status: 503 });
  }

  return NextResponse.json({
    index: created.index,
    token: created.token,
    expiresAt: created.expires_at,
  });
}
