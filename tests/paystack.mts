/**
 * Paystack helpers — the parts that can be tested without the network.
 *
 * The webhook signature check is the security-critical one: it is all that
 * stands between a POST from anyone on the internet and a student being marked
 * as having paid. The rest of settlement is guarded by re-verifying against
 * Paystack's API, which needs a live key and so is not exercised here.
 *
 *   npm run test:paystack
 */

// Set before the import: the module reads it when signing.
process.env.PAYSTACK_SECRET_KEY = "sk_test_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

import { createHmac } from "node:crypto";
import {
  placeholderEmail,
  newReference,
  signatureIsValid,
  verifyTransaction,
} from "../src/lib/paystack.ts";

let failed = 0;
function check(what: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"} — ${what}`);
  if (!ok) failed++;
}

const body = JSON.stringify({ event: "charge.success", data: { reference: "DF-ABC123", amount: 500000 } });
const good = createHmac("sha512", process.env.PAYSTACK_SECRET_KEY!).update(body).digest("hex");

check("a correct signature over the raw body is accepted", signatureIsValid(body, good));
check("a signature over re-serialised JSON is rejected",
  !signatureIsValid(JSON.stringify(JSON.parse(body)) + " ", good));
check("a tampered body is rejected",
  !signatureIsValid(body.replace("500000", "1"), good));
check("a missing signature is rejected", !signatureIsValid(body, null));
check("a wrong-length signature is rejected without throwing", !signatureIsValid(body, "abc"));
check("a signature made with another key is rejected",
  !signatureIsValid(body, createHmac("sha512", "sk_test_other").update(body).digest("hex")));

check("placeholder email uses an RFC 2606 reserved domain that can never deliver",
  placeholderEmail("CMP/2021/047").endsWith("@students.example.com"));
check("placeholder email carries the matric number and no slashes",
  placeholderEmail("CMP/2021/047") === "cmp-2021-047@students.example.com");
check("placeholder email has a real TLD, so a TLD-list validator accepts it",
  /\.(com|net|org)$/.test(placeholderEmail("MTH/2022/018")));

const refs = new Set(Array.from({ length: 5000 }, () => newReference()));
check("5000 references are unique", refs.size === 5000);
check("references are readable and prefixed", /^DF-[0-9A-F]{12}$/.test(newReference()));

/* ---------------------------------------------------------------------------
   verifyTransaction, against a stubbed Paystack
   ---------------------------------------------------------------------------

   These exist because assuming the shape of somebody else's error response
   cost two payments that sat on "Checking payment…" for ever. Paystack answers
   an unknown reference with 400, not the 404 the call's shape suggests.
   --------------------------------------------------------------------------- */

function stubFetch(status: number, payload: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

stubFetch(400, { status: false, message: "Transaction reference not found" });
check("an unknown reference (400) resolves as abandoned, not an error",
  (await verifyTransaction("DF-NOPE")).status === "abandoned");

stubFetch(404, { status: false, message: "Not Found" });
check("a 404 also resolves as abandoned",
  (await verifyTransaction("DF-NOPE")).status === "abandoned");

stubFetch(401, { status: false, message: "Invalid key" });
check("a bad key throws rather than marking the payment dead",
  await threw(() => verifyTransaction("DF-REAL")));

stubFetch(500, { status: false, message: "Internal error" });
check("a Paystack outage throws rather than marking the payment dead",
  await threw(() => verifyTransaction("DF-REAL")));

stubFetch(200, {
  status: true,
  data: { status: "success", amount: 500000, channel: "bank_transfer", paid_at: "2026-08-03T15:47:00Z" },
});
const paid = await verifyTransaction("DF-REAL");
check("a successful transfer reads back as success", paid.status === "success");
check("bank_transfer maps to the one word the product uses", paid.channel === "transfer");
check("the amount comes back in kobo", paid.amountKobo === 500000);

stubFetch(200, { status: true, data: { status: "ongoing", amount: 500000, channel: "card" } });
check("an unrecognised state is pending, never success",
  (await verifyTransaction("DF-REAL")).status === "pending");

async function threw(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

console.log(failed === 0 ? "\nALL PAYSTACK CHECKS PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
