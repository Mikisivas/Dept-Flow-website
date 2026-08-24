import { NextResponse } from "next/server";
import { reconcilePayments } from "@/lib/data/reconciliation";

/**
 * The payment reconciliation sweep (§8.4).
 *
 * Called every few minutes. It asks Paystack about anything whose webhook did
 * not arrive, credits what has been paid, and tells the student.
 *
 * Its value is not visible when it is working. A department that never sees a
 * stuck payment does not know whether that is because none get stuck or
 * because this catches them all — which is exactly why `/api/health` reports
 * the overdue count rather than leaving it to be inferred from silence.
 *
 * Safe to call often and safe to call twice: the schedule lives in the
 * database, so a second concurrent sweep finds the rows already pushed
 * forward, and `settlePayment()` returns early on anything already successful.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  // In production an unset secret closes the endpoint rather than opening it.
  // This one credits students' accounts; an open door to it is not a
  // convenience.
  if (!secret && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "CRON_SECRET is not set, so this endpoint is closed." },
      { status: 503 },
    );
  }

  try {
    const summary = await reconcilePayments();
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    // A sweep that fails wholesale is worth a 500 — the caller is a scheduler,
    // and a scheduler that sees 200 forever learns nothing.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The sweep failed." },
      { status: 500 },
    );
  }
}

/** So a person can run it by hand while watching, without a POST client. */
export const GET = POST;
