import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Paystack, server side only.
 *
 * The secret key never leaves this module's process. The browser gets an
 * authorization URL and nothing else — no key, no signature, no amount it
 * could tamper with, because the amount is read from `dues_periods` here
 * rather than sent up from the form.
 */

const BASE = "https://api.paystack.co";

/**
 * A missing key is a configuration fault, not a transient one, and the two need
 * different words on screen. "Try again in a moment" is a lie when nothing will
 * ever work until someone edits a file.
 */
export class PaystackNotConfigured extends Error {
  constructor() {
    super("PAYSTACK_SECRET_KEY is not set. Copy .env.example to .env.local and fill it in.");
    this.name = "PaystackNotConfigured";
  }
}

function secretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new PaystackNotConfigured();
  return key;
}

/**
 * Is the key present, and does Paystack accept it?
 *
 * Verifying a reference that cannot exist is the cheapest authenticated call
 * there is: a good key comes back 404 with a JSON body, a bad one comes back
 * 401, and no answer at all means the network is in the way. Those are three
 * different problems and this tells them apart in one request. Diagnostic only
 * — never called on the payment path.
 */
export async function paystackReachability(): Promise<{
  keyPresent: boolean;
  status: "ok" | "bad_key" | "unreachable" | "not_configured";
  detail: string;
}> {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return {
      keyPresent: false,
      status: "not_configured",
      detail: "PAYSTACK_SECRET_KEY is missing from .env.local.",
    };
  }

  try {
    const response = await fetch(`${BASE}/transaction/verify/dept-flow-health-probe`, {
      headers: { Authorization: `Bearer ${secretKey()}` },
      cache: "no-store",
    });

    if (response.status === 401) {
      return { keyPresent: true, status: "bad_key", detail: "Paystack rejected the key (401)." };
    }

    return {
      keyPresent: true,
      status: "ok",
      detail: `Paystack answered ${response.status} — the key works.`,
    };
  } catch (error) {
    return {
      keyPresent: true,
      status: "unreachable",
      detail: `Could not reach api.paystack.co: ${(error as Error).message}`,
    };
  }
}

/**
 * Paystack requires an email on every transaction. Dept-Flow collects none —
 * identity here is a matric number, and asking a student for an address just to
 * satisfy a field would put a contact detail in the system that nothing else
 * needs and someone would eventually mail.
 *
 * So the slot is filled with a derived address that can never reach a person.
 * `example.com` is reserved by RFC 2606, is held by IANA, and black-holes
 * everything sent to it. The matric number also travels in `metadata`, so the
 * Paystack dashboard stays searchable by the identifier the department
 * actually uses.
 *
 * This was `.invalid` first, which RFC 2606 reserves in the same breath. The
 * difference that matters to a payment processor: `.invalid` has no entry in
 * the root zone, so a validator checking the TLD against the real list rejects
 * the address, while `example.com` resolves and simply never delivers. Same
 * guarantee, fewer ways to be refused.
 */
export function placeholderEmail(matricNo: string): string {
  return `${matricNo.toLowerCase().replace(/\//g, "-")}@students.example.com`;
}

/**
 * Our reference, not Paystack's. Generating it up front means the row exists
 * before the student leaves the site, so an abandoned payment is a row we can
 * re-verify rather than a transaction we never heard about.
 */
export function newReference(): string {
  return `DF-${randomBytes(6).toString("hex").toUpperCase()}`;
}

export type InitializeResult = {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
};

export async function initializeTransaction(input: {
  reference: string;
  amountKobo: number;
  email: string;
  callbackUrl: string;
  /**
   * The method the student picked on our screen. Paystack shows only the
   * channels it is given and has no way to preselect one, so passing both
   * would make our radio group decorative. If the card fails, "Back to dues"
   * is where they choose the other one.
   */
  channel: "card" | "transfer";
  metadata: Record<string, unknown>;
}): Promise<InitializeResult> {
  const response = await fetch(`${BASE}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      reference: input.reference,
      // Paystack takes an integer number of kobo. Amounts are floats in our
      // schema by project decision, so this is the boundary cast.
      amount: Math.round(input.amountKobo),
      currency: "NGN",
      email: input.email,
      callback_url: input.callbackUrl,
      // Card and Pay with Transfer only. `dedicated_nuban` was dropped from
      // the spec and must not reappear here.
      channels: [input.channel === "card" ? "card" : "bank_transfer"],
      metadata: input.metadata,
    }),
    cache: "no-store",
  });

  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.status || !body?.data?.authorization_url) {
    throw new Error(body?.message ?? `Paystack rejected the transaction (${response.status})`);
  }

  return {
    authorizationUrl: body.data.authorization_url,
    accessCode: body.data.access_code,
    reference: body.data.reference,
  };
}

export type VerifiedTransaction = {
  status: "success" | "failed" | "abandoned" | "pending";
  amountKobo: number;
  channel: "card" | "transfer" | null;
  paidAt: string | null;
  raw: unknown;
};

/**
 * The only thing that may flip a student to cleared.
 *
 * A webhook body is a notification, never evidence — anyone can POST JSON at a
 * URL. Both the webhook and the return-URL path come through here, and this
 * asks Paystack directly.
 */
export async function verifyTransaction(reference: string): Promise<VerifiedTransaction> {
  const response = await fetch(`${BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secretKey()}` },
    cache: "no-store",
  });

  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.status) {
    throw new Error(body?.message ?? `Could not verify ${reference} (${response.status})`);
  }

  const data = body.data ?? {};

  return {
    status: normaliseStatus(data.status),
    amountKobo: Number(data.amount ?? 0),
    channel: normaliseChannel(data.channel),
    paidAt: data.paid_at ?? null,
    raw: data,
  };
}

/**
 * Paystack's channel vocabulary is wider than ours. `bank_transfer` and `bank`
 * both land in the one bucket the product has a name for; anything else is a
 * channel we did not offer and is not silently mapped to one we did.
 */
function normaliseChannel(channel: unknown): "card" | "transfer" | null {
  if (channel === "card") return "card";
  if (channel === "bank_transfer" || channel === "bank" || channel === "transfer") {
    return "transfer";
  }
  return null;
}

function normaliseStatus(status: unknown): VerifiedTransaction["status"] {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (status === "abandoned") return "abandoned";
  return "pending";
}

/**
 * Webhook authenticity: HMAC-SHA512 of the *raw* body with the secret key.
 *
 * It has to be the exact bytes Paystack sent. Re-serialising a parsed object
 * changes key order and whitespace and the signature stops matching, which is
 * why the route reads `request.text()` before it parses anything.
 */
export function signatureIsValid(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;

  const expected = createHmac("sha512", secretKey()).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");

  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and the length is not a secret.
  return a.length === b.length && timingSafeEqual(a, b);
}
