import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Resolving an attendance dispute.
 *
 * Correcting one changes an attendance percentage after the fact — the most
 * consequential write in the system that is not a payment. `resolve_dispute`
 * accepts the marks, re-scores through the same function the lecturer's close
 * uses, and writes both the before and after score to the audit row.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "hod") {
    return NextResponse.json({ error: "Only the HOD can resolve a dispute." }, { status: 403 });
  }

  let body: { disputeId?: string; uphold?: boolean; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const db = createServiceClient();
  const { data, error } = await db.rpc("resolve_dispute", {
    p_dispute_id: String(body.disputeId ?? ""),
    p_actor_id: session.profileId,
    p_uphold: body.uphold === true,
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
    return NextResponse.json({ error: "That dispute has already been resolved." }, { status: 409 });
  }
  if (data === "not_found") {
    return NextResponse.json({ error: "That dispute no longer exists." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, outcome: data });
}
