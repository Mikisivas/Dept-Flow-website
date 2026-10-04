import "server-only";

/**
 * A deployment for the project defence, not for a cohort.
 *
 * Switched on by `DEMO_DEPLOYMENT=true`. It changes exactly one behaviour and
 * says so on every page:
 *
 *   - **Verification codes are shown on screen** instead of sent, when no SMS
 *     or WhatsApp provider is connected. Registration and password reset both
 *     need a code to reach a phone, and neither provider is wired (see
 *     `src/lib/messaging.ts`). Without this, nobody on the panel could create
 *     an account, and the honest production behaviour — refuse — is the right
 *     behaviour for a real launch and the wrong one for a demonstration.
 *
 * Everything else behaves as production does. SMS and WhatsApp alerts still
 * fail and are recorded as failed, with a reason that says why; the in-app copy
 * and Web Push still work; nothing pretends to have been sent.
 *
 * THE INTERLOCK
 *
 * A code on screen proves nothing about a phone, which is the whole point of
 * the code. So demo mode refuses to engage next to a live Paystack key: a
 * deployment that can take real money is a real deployment, and one that
 * forgot to unset this flag must not hand out verification codes to whoever
 * types a matric number. Paystack test keys begin `sk_test_`.
 */
export function isDemoDeployment(): boolean {
  if (process.env.DEMO_DEPLOYMENT !== "true") return false;

  const key = process.env.PAYSTACK_SECRET_KEY ?? "";
  if (key && !key.startsWith("sk_test_")) {
    console.error(
      "DEMO_DEPLOYMENT is set alongside a live Paystack key. Demo mode is OFF: verification codes will not be shown.",
    );
    return false;
  }

  return true;
}
