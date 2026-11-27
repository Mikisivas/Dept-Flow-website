import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Someone reports that their matric number was registered by another person.
 *
 * Revoking does two things that have to happen together: it closes the
 * claiming account and it frees the register row, because the real student
 * cannot register while their own number is still marked claimed. Both live in
 * `resolve_registration_dispute`.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json(
      { error: "Only an administrator can resolve a registration dispute." },
      { status: 403 },
    );
  }

  let body: { disputeId?: string; revoke?: boolean; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const db = createServiceClient();
  const { data, error } = await db.rpc("resolve_registration_dispute", {
    p_dispute_id: String(body.disputeId ?? ""),
    p_actor_id: session.profileId,
    p_revoke: body.revoke === true,
    p_reason: String(body.reason ?? "").trim(),
  });

  if (error) {
    const cleaned = error.message.replace(/^.*?:\s*/, "").trim();
    return NextResponse.json(
      { error: cleaned.charAt(0).toUpperCase() + cleaned.slice(1) },
      { status: 400 },
    );
  }

  if (data === "already_resolved") {
    return NextResponse.json({ error: "That report has already been resolved." }, { status: 409 });
  }
  if (data === "not_found") {
    return NextResponse.json({ error: "That report no longer exists." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, outcome: data });
}
