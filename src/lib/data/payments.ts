import "server-only";

import { createServiceClient, createUserClient } from "@/lib/supabase/client";
import { currentAccessToken } from "@/lib/auth/current-user";
import {
  initializeTransaction,
  newReference,
  placeholderEmail,
  verifyTransaction,
} from "@/lib/paystack";
import type { PaymentChannel, PaymentRecord } from "@/lib/types";

export type { PaymentRecord };

/**
 * Dues payment, server side.
 *
 * The whole product turns on this file: `clear_student()` flips the student to
 * cleared AND confirms every provisional score in one transaction, so a
 * half-applied payment would leave someone paid and uncounted. That function is
 * the authoritative implementation and nothing here reimplements any of it.
 */

export type StartResult =
  | { outcome: "redirect"; authorizationUrl: string; reference: string }
  | { outcome: "already_cleared" }
  | { outcome: "no_dues_period" };

export async function startDuesPayment(
  studentId: string,
  channel: PaymentChannel,
): Promise<StartResult> {
  const db = createServiceClient();

  const { data: student } = await db
    .from("students")
    .select("id, matric_no")
    .eq("id", studentId)
    .single();

  if (!student) throw new Error("No such student.");

  const { data: session } = await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .single();

  if (!session) return { outcome: "no_dues_period" };

  const { data: dues } = await db
    .from("dues_periods")
    .select("dues_amount_kobo")
    .eq("academic_session_id", session.id)
    .maybeSingle();

  if (!dues) return { outcome: "no_dues_period" };

  const { data: compliance } = await db
    .from("compliance_statuses")
    .select("state")
    .eq("student_id", studentId)
    .eq("academic_session_id", session.id)
    .maybeSingle();

  // Charging a student who is already cleared is the one outcome with no way
  // back that does not involve a refund.
  if (compliance?.state === "cleared") return { outcome: "already_cleared" };

  const reference = newReference();

  // The row is written before the student leaves for Paystack. An abandoned
  // payment is then a pending row we can re-verify, rather than a transaction
  // we never knew existed.
  const { error } = await db.from("payments").insert({
    student_id: studentId,
    academic_session_id: session.id,
    paystack_reference: reference,
    status: "pending",
    // Read from dues_periods, never from the browser. A client that can name
    // its own price has defeated the whole flow.
    amount_kobo: dues.dues_amount_kobo,
  });

  if (error) throw new Error(`Could not record the payment: ${error.message}`);

  const { authorizationUrl } = await initializeTransaction({
    reference,
    amountKobo: Number(dues.dues_amount_kobo),
    email: placeholderEmail(student.matric_no),
    callbackUrl: callbackUrlFor(reference),
    channel,
    metadata: {
      matric_no: student.matric_no,
      academic_session_id: session.id,
      // Shown on the Paystack dashboard's transaction list.
      custom_fields: [
        {
          display_name: "Matric number",
          variable_name: "matric_no",
          value: student.matric_no,
        },
      ],
    },
  });

  return { outcome: "redirect", authorizationUrl, reference };
}

function callbackUrlFor(reference: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  return `${base}/dues/result?ref=${encodeURIComponent(reference)}`;
}

export type SettleOutcome = {
  status: "success" | "pending" | "failed";
  reference: string;
  amountKobo: number;
  /** Sessions confirmed by this payment. Null when it did not clear anyone. */
  sessionsCounted: number | null;
  /** Set when the money arrived but does not match what is owed. */
  mismatch?: { paidKobo: number; dueKobo: number };
};

/**
 * Verify a reference with Paystack and apply whatever it turns out to be.
 *
 * Safe to call repeatedly and from both directions — the webhook and the
 * student's return from checkout race each other by design, and on a laptop in
 * development the webhook never arrives at all.
 */
export async function settlePayment(
  reference: string,
  /**
   * Set when a student is settling their own return from checkout. References
   * are guessable enough that a screen reachable with one in the query string
   * must not act on somebody else's.
   */
  expectStudentId?: string,
): Promise<SettleOutcome> {
  const db = createServiceClient();

  const { data: payment } = await db
    .from("payments")
    .select("id, student_id, academic_session_id, amount_kobo, status")
    .eq("paystack_reference", reference)
    .maybeSingle();

  if (!payment) throw new Error("Unknown payment reference.");
  if (expectStudentId && payment.student_id !== expectStudentId) {
    throw new Error("That payment is not yours.");
  }

  // Already applied. Re-clearing would rewrite cleared_at and, worse, re-run
  // the score confirmation for a student who may since have been locked.
  if (payment.status === "success") {
    return {
      status: "success",
      reference,
      amountKobo: Number(payment.amount_kobo),
      sessionsCounted: null,
    };
  }

  const verified = await verifyTransaction(reference);

  await db
    .from("payments")
    .update({ last_checked_at: new Date().toISOString() })
    .eq("id", payment.id);

  if (verified.status === "pending") {
    return {
      status: "pending",
      reference,
      amountKobo: Number(payment.amount_kobo),
      sessionsCounted: null,
    };
  }

  if (verified.status !== "success") {
    await db
      .from("payments")
      .update({ status: verified.status, verification_payload: verified.raw })
      .eq("id", payment.id);

    return {
      status: "failed",
      reference,
      amountKobo: Number(payment.amount_kobo),
      sessionsCounted: null,
    };
  }

  // Float-safe, via the database's own comparison so there is one rule.
  const { data: matches } = await db.rpc("payment_matches_dues", {
    paid_kobo: verified.amountKobo,
    due_kobo: Number(payment.amount_kobo),
  });

  if (matches !== true) {
    // Money arrived and does not settle the debt. Recorded, not cleared, and
    // not silently accepted — an underpayment is a thing a person has to look
    // at, and the payload is kept so they can.
    await db
      .from("payments")
      .update({
        status: "pending",
        verification_payload: verified.raw,
      })
      .eq("id", payment.id);

    return {
      status: "pending",
      reference,
      amountKobo: verified.amountKobo,
      sessionsCounted: null,
      mismatch: { paidKobo: verified.amountKobo, dueKobo: Number(payment.amount_kobo) },
    };
  }

  const { error: paidError } = await db
    .from("payments")
    .update({
      status: "success",
      channel: verified.channel,
      verified_at: verified.paidAt ?? new Date().toISOString(),
      verification_payload: verified.raw,
    })
    .eq("id", payment.id);

  if (paidError) throw new Error(`Could not record the payment: ${paidError.message}`);

  // One transaction: the state flips and every provisional score for this
  // academic session becomes confirmed together. Partially confirmed is not a
  // state this system has.
  const { data: counted, error: clearError } = await db.rpc("clear_student", {
    p_student_id: payment.student_id,
    p_academic_session_id: payment.academic_session_id,
    p_route: "payment",
    p_actor_id: null,
  });

  if (clearError) {
    // The money is recorded but the student is not cleared, which is the one
    // outcome nobody can see from the outside. Loud, not swallowed.
    throw new Error(
      `Payment ${reference} verified but clearing failed: ${clearError.message}`,
    );
  }

  return {
    status: "success",
    reference,
    amountKobo: verified.amountKobo,
    sessionsCounted: typeof counted === "number" ? counted : null,
  };
}

/**
 * The student's own payment history.
 *
 * Read under the student's token, so `payments_self_read` is what scopes it —
 * not the `eq` below, which is there to keep the query small.
 */
export async function loadPaymentHistory(studentId: string): Promise<PaymentRecord[]> {
  const db = createUserClient(await currentAccessToken());

  const { data } = await db
    .from("payments")
    .select("paystack_reference, amount_kobo, status, channel, verified_at, initialized_at")
    .eq("student_id", studentId)
    .order("initialized_at", { ascending: false });

  return (data ?? []).map((row) => ({
    reference: row.paystack_reference,
    amountKobo: Number(row.amount_kobo),
    status: row.status,
    channel: row.channel,
    paidAt: row.verified_at,
    startedAt: row.initialized_at,
  }));
}
