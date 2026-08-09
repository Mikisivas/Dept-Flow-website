import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Opening and revoking a grace period.
 *
 * An authority action: it changes the standing of a whole level at once, so
 * every rule the hard rules demand — a reason, an actor, an audit row — is
 * enforced inside the database functions rather than here. This route decides
 * who is allowed to call them and nothing else.
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

  const scope = body.scope === "level" ? "level" : "department";
  const { error } = await db.rpc("open_grace_period", {
    p_academic_session_id: active.id,
    p_scope: scope,
    p_level: scope === "level" ? Number(body.level) : null,
    p_expires_on: String(body.expiresOn ?? ""),
    p_reason: reason,
    p_actor_id: session.profileId,
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
