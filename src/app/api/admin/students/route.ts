import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Deactivating a student, and reversing it.
 *
 * Deactivation is a soft delete: the login stops, every row is kept, and the
 * matric number stays retired. All of that lives in `deactivate_student` —
 * this route decides nothing, it only carries the actor and the note.
 */

const REASONS = ["expelled", "withdrawn", "graduated", "other"] as const;
type Reason = (typeof REASONS)[number];

export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json(
      { error: "Only an administrator can change a student's status." },
      { status: 403 },
    );
  }

  let body: { studentId?: string; reactivate?: boolean; reason?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const db = createServiceClient();
  const note = String(body.note ?? "").trim();

  if (body.reactivate === true) {
    const { data, error } = await db.rpc("reactivate_student", {
      p_student_id: String(body.studentId ?? ""),
      p_actor_id: session.profileId,
      p_note: note,
    });
    return translate(data, error, {
      not_deactivated: "That student is already active.",
    });
  }

  const reason = String(body.reason ?? "").toLowerCase() as Reason;
  if (!REASONS.includes(reason)) {
    return NextResponse.json({ error: "Choose a reason for the deactivation." }, { status: 400 });
  }

  const { data, error } = await db.rpc("deactivate_student", {
    p_student_id: String(body.studentId ?? ""),
    p_actor_id: session.profileId,
    p_reason: reason,
    p_note: note,
  });

  return translate(data, error, {
    already_deactivated: "That student has already been deactivated.",
  });
}

function translate(
  data: unknown,
  error: { message: string } | null,
  conflicts: Record<string, string>,
) {
  if (error) {
    const cleaned = error.message.replace(/^.*?:\s*/, "").trim();
    return NextResponse.json(
      { error: cleaned.charAt(0).toUpperCase() + cleaned.slice(1) },
      { status: 400 },
    );
  }

  if (data === "not_found") {
    return NextResponse.json({ error: "That student no longer exists." }, { status: 404 });
  }

  const conflict = conflicts[String(data)];
  if (conflict) return NextResponse.json({ error: conflict }, { status: 409 });

  return NextResponse.json({ ok: true, outcome: data });
}
