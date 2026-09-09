import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";
import { ok } from "@/lib/supabase/result";

/**
 * Allocating a student's permit reference.
 *
 * `issue_exam_permit` is idempotent: one reference per student per session,
 * allocated once. Re-issuing on every download would make every previously
 * printed copy unverifiable, which is the opposite of what a reference is for.
 *
 * It answers in three ways, and each needs relaying differently:
 *
 *   * null — no authorized eligibility list marks the student eligible for
 *     anything. Before the department has decided, there is no permit.
 *   * an error naming outstanding dues — §9.1's other half. Recoverable, and
 *     the student is the one who can recover it.
 *   * a reference — both conditions met.
 *
 * The permit page already refuses to render while dues are outstanding, so
 * this branch catches the request that came from somewhere else: a stale tab,
 * a reversed payment between page load and click, a direct POST.
 */
export async function POST() {
  const session = await currentUser();
  if (!session || session.role !== "student") {
    return NextResponse.json({ error: "Only a student has an exam permit." }, { status: 403 });
  }

  const db = createServiceClient();

  const { data: active } = ok(await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .maybeSingle(), "active");

  if (!active) {
    return NextResponse.json({ error: "There is no active session." }, { status: 409 });
  }

  const { data, error } = await db.rpc("issue_exam_permit", {
    p_student_id: session.profileId,
    p_academic_session_id: active.id,
  });

  if (error) {
    // §9.1. The database refuses while dues are outstanding, and the refusal
    // is worth relaying properly: "could not issue your permit" tells a
    // student nothing, while the balance tells them exactly what to do. The
    // amount is read back rather than parsed out of the error text, so a
    // reworded exception cannot turn into a wrong number on a screen.
    if (/dues outstanding/i.test(error.message)) {
      const { data: owed } = ok(await db.rpc("dues_balance_kobo", {
        p_student_id: session.profileId,
        p_academic_session_id: active.id,
      }), "owed");

      return NextResponse.json(
        {
          error:
            "Your permit needs your dues paid in full. Pay the balance and it becomes available straight away.",
          duesOutstandingKobo: Number(owed ?? 0),
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ error: "Could not issue your permit." }, { status: 400 });
  }

  if (!data) {
    return NextResponse.json(
      {
        error:
          "No permit yet — the eligibility list for your courses has not been authorized, or it does not clear you for any paper.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, reference: data });
}
