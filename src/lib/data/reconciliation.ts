import "server-only";

import { createServiceClient } from "@/lib/supabase/client";
import { settlePayment } from "@/lib/data/payments";
import { dispatchQueuedNotifications } from "@/lib/data/notifications";
import { naira } from "@/lib/format";
import { ok, QueryFailed } from "@/lib/supabase/result";

/**
 * Payments that settle themselves (§8.4).
 *
 * The problem this removes: a student pays, Paystack's webhook is lost — a
 * deploy mid-flight, a network blip, a 500 from our own side — and the money
 * sits in the department's account uncredited until somebody notices and
 * presses re-verify. Nobody notices. The student notices, weeks later, at the
 * exam permit.
 *
 * So there is no re-verify button anywhere in this system, and no screen that
 * needs one. Three things now cover a payment:
 *
 *   1. The webhook, when it arrives.
 *   2. The student's return from checkout, which settles immediately.
 *   3. This sweep, which asks about anything the first two missed, on a
 *      schedule that widens as the payment ages.
 *
 * All three funnel into `settlePayment()`, so there is one path that can
 * credit a student and one place the rules live. The sweep adds nothing of its
 * own except persistence and a notification.
 */

export type SweepSummary = {
  checked: number;
  settled: number;
  stillPending: number;
  unreachable: number;
  abandoned: number;
};

/** Bounded. A sweep is a scheduled job, not a migration. */
const BATCH = 25;

export async function reconcilePayments(limit = BATCH): Promise<SweepSummary> {
  const db = createServiceClient();

  const { data: due } = ok(await db.rpc("payments_due_for_check", { p_limit: limit }), "due");

  const rows = (due ?? []) as Array<{
    payment_id: string;
    reference: string;
    student_id: string;
  }>;

  const summary: SweepSummary = {
    checked: 0,
    settled: 0,
    stillPending: 0,
    unreachable: 0,
    abandoned: 0,
  };

  for (const row of rows) {
    summary.checked += 1;

    try {
      const outcome = await settlePayment(row.reference);

      if (outcome.status === "success") {
        summary.settled += 1;
        // Told, rather than left to discover it. The whole point of the sweep
        // is that nobody had to go looking — which is only half true if the
        // student still has to go looking to find out it worked.
        await announce(db, row.student_id, outcome.amountKobo, outcome.cleared);
        // Resolved, so the schedule is cleared rather than widened.
        await db.rpc("schedule_payment_check", { p_payment_id: row.payment_id });
        continue;
      }

      if (outcome.status === "pending") {
        summary.stillPending += 1;
      }

      // Paystack answered — "pending", "failed" or "abandoned" — so the age
      // curve applies and the row can eventually be given up on.
      const { data: next } = ok(await db.rpc("schedule_payment_check", {
        p_payment_id: row.payment_id,
        p_answered: true,
      }), "next");

      if (next === null) summary.abandoned += 1;
    } catch (error) {
      // This catch means one thing: Paystack could not be asked. A refused
      // query is not that, and counting it as unreachable would file a broken
      // database under weather — a number that is supposed to go up and down
      // on its own, so nobody looks twice at it.
      if (error instanceof QueryFailed) throw error;

      // We could not ask. That is a fact about the network and not about the
      // student's money, so it is rescheduled and never abandoned — however
      // many times it happens.
      summary.unreachable += 1;
      await db.rpc("schedule_payment_check", {
        p_payment_id: row.payment_id,
        p_answered: false,
      });
    }
  }

  // Drained here rather than left for the notification tick. A student whose
  // payment was rescued twenty minutes ago should not wait another cron cycle
  // to hear about it.
  if (summary.settled > 0) await dispatchQueuedNotifications(50);

  return summary;
}

/**
 * The message a rescued payment produces.
 *
 * Deliberately not inside `apply_payment()`. That function also runs on the
 * interactive path, where the student is watching the screen that already says
 * it worked — and a notification arriving about something you are looking at
 * is noise. This one exists precisely because nobody was looking.
 */
async function announce(
  db: ReturnType<typeof createServiceClient>,
  studentId: string,
  amountKobo: number,
  cleared: boolean,
): Promise<void> {
  // Checked. This whole function exists because nobody was looking at the
  // screen, so a queue_notification that failed quietly means the student is
  // never told at all — the sweep credits the money and says nothing.
  ok(await db.rpc("queue_notification", {
    p_recipient_id: studentId,
    p_kind: "payment_confirmed",
    p_title: cleared ? "Your dues are paid in full" : "Your payment came through",
    p_body: cleared
      ? `We confirmed ${naira(amountKobo)} with Paystack. Your dues are now clear — the attendance half of your exam permit is the only thing left.`
      : `We confirmed ${naira(amountKobo)} with Paystack and it has come off your balance.`,
    p_link: "/dues",
  }), "the payment notice");
}
