import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Opening and revoking a registration exception.
 *
 * An authority action: it decides who may record attendance, so every rule the
 * hard rules demand — a reason, an actor, an audit row — is enforced inside the
 * database functions rather than here. This route decides who is allowed to
 * call them, resolves a matric number to a student, and nothing else.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "hod") {
    return NextResponse.json(
      { error: "Only the HOD can open or end a grace period." },
      { status: 403 },
    );
  }

  let body: {
    action?: string;
    scope?: string;
    level?: number;
    matricNo?: string;
    expiresOn?: string;
    reason?: string;
    graceId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const reason = String(body.reason ?? "").trim();
  const db = createServiceClient();

  if (body.action === "revoke") {
    const { data, error } = await db.rpc("revoke_grace_period", {
      p_grace_id: String(body.graceId ?? ""),
      p_actor_id: session.profileId,
      p_reason: reason,
    });

    if (error) return NextResponse.json({ error: readable(error.message) }, { status: 400 });
    if (data !== true) {
      return NextResponse.json(
        { error: "That grace period has already ended." },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  }

  const { data: active } = await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .single();

  if (!active) {
    return NextResponse.json({ error: "There is no active academic session." }, { status: 409 });
  }

  const scope =
    body.scope === "level" ? "level" : body.scope === "student" ? "student" : "department";

  // The matric number is what the HOD typed; the student id is what the
  // function needs. Resolved here rather than trusted from the client, and a
  // number that names nobody is told so plainly — the alternative is an
  // exception silently opened for no one.
  let studentId: string | null = null;
  if (scope === "student") {
    const matricNo = String(body.matricNo ?? "").trim().toUpperCase();
    const { data: student } = await db
      .from("students")
      .select("id, status")
      .eq("matric_no", matricNo)
      .maybeSingle();

    if (!student) {
      return NextResponse.json(
        { error: `No student is registered under ${matricNo || "that matric number"}.` },
        { status: 404 },
      );
    }
    if (student.status === "deactivated") {
      return NextResponse.json(
        { error: "That account is deactivated. Reactivate it before granting an exception." },
        { status: 409 },
      );
    }
    studentId = student.id;
  }

  const { error } = await db.rpc("open_grace_period", {
    p_academic_session_id: active.id,
    p_scope: scope,
    p_level: scope === "level" ? Number(body.level) : null,
    p_expires_on: String(body.expiresOn ?? ""),
    p_reason: reason,
    p_actor_id: session.profileId,
    p_student_id: studentId,
  });

  if (error) return NextResponse.json({ error: readable(error.message) }, { status: 400 });

  return NextResponse.json({ ok: true });
}

/**
 * The database raises in plain English already. This strips Postgres's prefix
 * so the HOD reads the sentence rather than the plumbing around it.
 */
function readable(message: string): string {
  const cleaned = message.replace(/^.*?:\s*/, "").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
