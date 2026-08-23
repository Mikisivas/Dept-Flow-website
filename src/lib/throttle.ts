import "server-only";

import { createServiceClient } from "@/lib/supabase/client";

/**
 * Rate limiting, keyed on the caller.
 *
 * The registration flow already limited OTP sends per phone number, and that
 * limit does nothing against the attack §1.6 names: a script claiming the
 * roster varies the phone number on every request, so every request is the
 * first one for its number. What has to be limited is whoever is calling, and
 * specifically the register-match step — the one that answers "is CMP/2021/047
 * a real, unclaimed matric number" and can therefore be walked through the
 * whole department one number at a time.
 *
 * Counted in the database rather than in memory, because one Next.js instance
 * is not the only instance and a counter that resets on deploy is one a
 * patient script outlasts.
 */

export type Bucket =
  | "register:check"
  | "register:otp"
  | "attendance-code"
  | "login"
  | "password-reset";

const LIMITS: Record<Bucket, { limit: number; windowSeconds: number }> = {
  // The roster walk. Twenty a minute is far above what a person filling in a
  // form does and far below what enumerating a department needs.
  "register:check": { limit: 20, windowSeconds: 60 },
  // Sends cost money once a provider is wired, so this is tighter.
  "register:otp": { limit: 5, windowSeconds: 600 },
  // Four digits is ten thousand guesses, which is a short script. Generous
  // enough that mistyping twice in a noisy hall costs a student nothing.
  "attendance-code": { limit: 12, windowSeconds: 300 },
  "login": { limit: 10, windowSeconds: 300 },
  "password-reset": { limit: 5, windowSeconds: 900 },
};

/**
 * The caller, as well as it can be known.
 *
 * Behind a proxy the socket address is the proxy, so the forwarded header is
 * what identifies anyone — and it is client-supplied, so a determined script
 * can rotate it. That is a real limit of this and the reason the throttle is a
 * speed bump rather than a wall: it stops the casual enumeration of a public
 * form, and CAPTCHA is what the doc pairs it with for the rest.
 */
export function callerFrom(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() ?? "";
}

/**
 * True when the caller may proceed.
 *
 * Fails OPEN on a database error. A throttle that cannot reach its counter and
 * therefore refuses everyone has turned a rate limiter into an outage, which
 * is a worse failure than the one it exists to prevent.
 */
export async function allow(bucket: Bucket, subject: string): Promise<boolean> {
  if (!subject) return true;

  const { limit, windowSeconds } = LIMITS[bucket];

  try {
    const db = createServiceClient();
    const { data, error } = await db.rpc("take_token", {
      p_bucket: bucket,
      p_subject: subject,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });

    if (error) return true;
    return data !== false;
  } catch {
    return true;
  }
}
