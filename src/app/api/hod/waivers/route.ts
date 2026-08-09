import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Deciding a waiver.
 *
 * Granting clears the student, which confirms every provisional score they
 * hold — the same transition a payment produces, because a waiver is the
 * department deciding the money is not owed. That consequence lives in
 * `decide_waiver`, not here.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "hod") {
    return NextResponse.json({ error: "Only the HOD can decide a waiver." }, { status: 403 });
  }

  let body: { waiverId?: string; grant?: boolean; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const db = createServiceClient();
  const { data, error } = await db.rpc("decide_waiver", {
    p_waiver_id: String(body.waiverId ?? ""),
    p_actor_id: session.profileId,
    p_grant: body.grant === true,
    p_reason: String(body.reason ?? "").trim(),
  });

  if (error) {
    const cleaned = error.message.replace(/^.*?:\s*/, "").trim();
    return NextResponse.json(
      { error: cleaned.charAt(0).toUpperCase() + cleaned.slice(1) },
      { status: 400 },
    );
  }

  if (data === "already_decided") {
    return NextResponse.json({ error: "That request has already been decided." }, { status: 409 });
  }
  if (data === "not_found") {
    return NextResponse.json({ error: "That request no longer exists." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, outcome: data });
}
