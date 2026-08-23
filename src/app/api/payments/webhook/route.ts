import { NextResponse } from "next/server";
import { signatureIsValid } from "@/lib/paystack";
import { settlePayment } from "@/lib/data/payments";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Paystack's webhook.
 *
 * The body is a notification, not evidence — anyone can POST JSON at a public
 * URL. Two things stand between that and a cleared student: the HMAC signature
 * over the raw bytes, and the fact that `settlePayment` re-verifies the
 * reference against Paystack's own API before it changes anything.
 *
 * This endpoint cannot reach a laptop, so in development the student's return
 * from checkout is what settles the payment. That is not a workaround: a
 * transfer settles asynchronously and the student often gets back first, so
 * both paths have to work anyway.
 *
 * Paystack retries a delivery it did not get a 200 for, and retries are not
 * rare. Every event is recorded by its own id first, and a duplicate insert is
 * the signal to stop — refused by a primary key rather than by a check
 * somebody remembered to write. Nothing downstream double-counted while a
 * payment was a boolean; with a running balance, a second credit is a student
 * who appears to have paid twice what they did.
 */
export async function POST(request: Request) {
  // Raw bytes, before any parsing. Re-serialising a parsed object changes key
  // order and whitespace, and the signature stops matching.
  const raw = await request.text();

  if (!signatureIsValid(raw, request.headers.get("x-paystack-signature"))) {
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }

  let event: { id?: string; event?: string; data?: { id?: number; reference?: string } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Malformed body." }, { status: 400 });
  }

  const reference = event.data?.reference;
  if (!reference) return NextResponse.json({ ignored: true });

  // Paystack's own identifier for the delivery. Falling back to the
  // transaction id keeps this working if a payload arrives without one — what
  // must never happen is a synthesised id, which would make every retry look
  // like a new event and defeat the whole mechanism.
  const eventId = event.id ?? (event.data?.id != null ? `txn:${event.data.id}` : null);

  if (eventId) {
    const db = createServiceClient();
    const { error } = await db.from("payment_events").insert({
      event_id: String(eventId),
      event_type: String(event.event ?? "unknown"),
      reference,
      payload: event,
    });

    // 23505 is unique_violation: this exact event has already been handled.
    // A 200 stops Paystack retrying it, which is the right answer — the work
    // was done the first time.
    if (error?.code === "23505") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
  }

  try {
    await settlePayment(reference);
  } catch (error) {
    console.error("webhook settle failed", reference, error);
    // A 500 tells Paystack to retry, which is what we want: the alternative is
    // a student who paid and was never cleared, with nothing left to replay.
    return NextResponse.json({ error: "Could not settle." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
