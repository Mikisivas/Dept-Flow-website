import { NextResponse } from "next/server";
import { signatureIsValid } from "@/lib/paystack";
import { settlePayment } from "@/lib/data/payments";

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
 */
export async function POST(request: Request) {
  // Raw bytes, before any parsing. Re-serialising a parsed object changes key
  // order and whitespace, and the signature stops matching.
  const raw = await request.text();

  if (!signatureIsValid(raw, request.headers.get("x-paystack-signature"))) {
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }

  let event: { event?: string; data?: { reference?: string } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Malformed body." }, { status: 400 });
  }

  const reference = event.data?.reference;
  if (!reference) return NextResponse.json({ ignored: true });

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
