import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * The admin opening or moving a semester's registration window.
 *
 * The window is the gate the revision put at the centre of the system: past its
 * closing date an unconfirmed student cannot record attendance, and confirming
 * afterwards backfills an absence for every lecture already held. Until this
 * route existed the row could only be written with SQL access, and its absence
 * is silent — an unconfigured window reads as OPEN, deliberately, so nothing
 * breaks and the gate simply never engages.
 *
 * Who may call it, what counts as a reason, and the audit row all live in
 * `set_registration_period()`. This route decides who is allowed to reach it
 * and which session the dates belong to.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json(
      { error: "Only an administrator can set the registration window." },
      { status: 403 },
    );
  }

  let body: { semester?: number; opensOn?: string; closesOn?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const semester = Number(body.semester);
  if (semester !== 1 && semester !== 2) {
    return NextResponse.json({ error: "Which semester?" }, { status: 400 });
  }

  const opensOn = String(body.opensOn ?? "").trim();
  const closesOn = String(body.closesOn ?? "").trim();
  if (!opensOn || !closesOn) {
    return NextResponse.json(
      { error: "A window needs both an opening and a closing date." },
      { status: 400 },
    );
  }

  const db = createServiceClient();

  // The active session, not one named in the request. A window is only ever set
  // for the session the department is actually in, and taking the id from the
  // body would let a misdirected request move a closed session's deadline.
  const { data: active } = await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .limit(1);

  const current = active?.[0];
  if (!current) {
    return NextResponse.json(
      { error: "There is no active session to set a window for." },
      { status: 409 },
    );
  }

  const { data, error } = await db.rpc("set_registration_period", {
    p_actor_id: session.profileId,
    p_academic_session_id: current.id,
    p_semester: semester,
    p_opens_on: opensOn,
    p_closes_on: closesOn,
    p_reason: String(body.reason ?? "").trim(),
  });

  if (error) {
    const cleaned = error.message.replace(/^.*?:\s*/, "").trim();
    return NextResponse.json(
      { error: cleaned.charAt(0).toUpperCase() + cleaned.slice(1) },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true, periodId: data });
}
