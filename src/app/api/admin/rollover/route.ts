import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * The level rollover.
 *
 * The most destructive write in the system: every student's level changes at
 * once, and level decides which courses they are enrolled in. The route adds
 * one protection the database cannot — the caller must echo back the name of
 * the session being closed, so the request cannot be produced by a mis-click.
 * Everything else (graduands first, refuse a second run, one transaction)
 * lives in `run_level_rollover`.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json(
      { error: "Only an administrator can run a level rollover." },
      { status: 403 },
    );
  }

  let body: { toSessionId?: string; confirmSessionName?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const db = createServiceClient();

  const { data: active } = await db
    .from("academic_sessions")
    .select("id, name")
    .eq("is_active", true)
    .limit(1);

  const current = active?.[0];
  if (!current) {
    return NextResponse.json({ error: "There is no active session to roll over." }, { status: 409 });
  }

  if (String(body.confirmSessionName ?? "").trim() !== current.name) {
    return NextResponse.json(
      { error: `Type ${current.name} exactly to confirm which session you are closing.` },
      { status: 400 },
    );
  }

  const { data, error } = await db.rpc("run_level_rollover", {
    p_to_session_id: String(body.toSessionId ?? ""),
    p_actor_id: session.profileId,
    p_note: String(body.note ?? "").trim(),
  });

  if (error) {
    const cleaned = error.message.replace(/^.*?:\s*/, "").trim();
    return NextResponse.json(
      { error: cleaned.charAt(0).toUpperCase() + cleaned.slice(1) },
      { status: 400 },
    );
  }

  const result = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({
    ok: true,
    promoted: result?.promoted ?? 0,
    graduating: result?.graduating ?? 0,
  });
}
