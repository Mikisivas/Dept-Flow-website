import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";
import { ok } from "@/lib/supabase/result";

/**
 * The admin setting the session's dues.
 *
 * One row per session, never per semester: departmental dues are charged for
 * the year, and `dues_balance_kobo()` looks the figure up by session alone.
 *
 * The `impact` action exists because raising the figure is silent. Every
 * consequential reader computes from it live — the balance, the permit's dues
 * gate, the HOD's compliance report — so a raise puts every fully-paid student
 * back in debt the moment it is saved, with no other symptom until they try to
 * print a permit. The count belongs on the screen before the decision, not in
 * the permit queue afterwards.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json(
      { error: "Only an administrator can set the dues." },
      { status: 403 },
    );
  }

  let body: {
    action?: string;
    amountKobo?: number;
    resumptionDate?: string;
    reason?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const amountKobo = Number(body.amountKobo);
  if (!Number.isFinite(amountKobo) || amountKobo <= 0) {
    return NextResponse.json(
      { error: "The dues amount must be more than zero." },
      { status: 400 },
    );
  }
  if (!Number.isInteger(amountKobo)) {
    return NextResponse.json(
      { error: "The dues amount must be a whole number of kobo." },
      { status: 400 },
    );
  }

  const db = createServiceClient();

  const { data: active } = ok(await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .limit(1), "active");

  const current = active?.[0];
  if (!current) {
    return NextResponse.json(
      { error: "There is no active session to set dues for." },
      { status: 409 },
    );
  }

  if (body.action === "impact") {
    const { data } = ok(await db.rpc("dues_change_impact", {
      p_academic_session_id: current.id,
      p_amount_kobo: amountKobo,
    }), "the dues change impact");
    const row = Array.isArray(data) ? data[0] : data;
    return NextResponse.json({
      students: Number(row?.students ?? 0),
      paidInFullNow: Number(row?.paid_in_full_now ?? 0),
      paidInFullAfter: Number(row?.paid_in_full_after ?? 0),
      newlyOwing: Number(row?.newly_owing ?? 0),
    });
  }

  const resumptionDate = String(body.resumptionDate ?? "").trim();
  if (!resumptionDate) {
    return NextResponse.json(
      { error: "A dues period needs a resumption date. It is day 0." },
      { status: 400 },
    );
  }

  const { data, error } = await db.rpc("set_dues_period", {
    p_actor_id: session.profileId,
    p_academic_session_id: current.id,
    p_resumption_date: resumptionDate,
    p_dues_amount_kobo: amountKobo,
    p_reason: String(body.reason ?? "").trim(),
  });

  if (error) {
    const cleaned = error.message.replace(/^.*?:\s*/, "").trim();
    return NextResponse.json(
      { error: cleaned.charAt(0).toUpperCase() + cleaned.slice(1) },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true, duesPeriodId: data });
}
