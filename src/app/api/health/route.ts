import { NextResponse } from "next/server";
import { createUserClient } from "@/lib/supabase/client";
import { currentAccessToken, currentUser } from "@/lib/auth/current-user";
import { paystackReachability } from "@/lib/paystack";

/**
 * Reports what the signed-in user can actually reach, one table at a time.
 *
 * Written for the round trip: when a screen misbehaves against a real project,
 * "which table failed and with what message" is the whole diagnosis, and
 * reading it from a JSON response beats reading it from a stack trace.
 *
 * It reports counts and error messages — never row contents — and every query
 * runs under the caller's own token, so it can only see what they can see.
 */
const TABLES = [
  "profiles",
  "students",
  "academic_sessions",
  "dues_periods",
  "compliance_statuses",
  "enrolments",
  "courses",
  "session_instances",
  "session_scores",
  "risk_predictions",
] as const;

export async function GET() {
  const session = await currentUser();

  if (!session) {
    return NextResponse.json(
      { signedIn: false, hint: "Log in first — this reports what your session can read." },
      { status: 401 },
    );
  }

  const token = await currentAccessToken();
  const db = createUserClient(token);

  const results = await Promise.all(
    TABLES.map(async (table) => {
      const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
      return [table, error ? { error: error.message } : { rows: count ?? 0 }] as const;
    }),
  );

  const env = {
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    SUPABASE_JWT_SECRET: Boolean(process.env.SUPABASE_JWT_SECRET),
    PAYSTACK_SECRET_KEY: Boolean(process.env.PAYSTACK_SECRET_KEY),
    // Paystack sends the student back here after checkout. Pointing it at
    // localhost while testing on a phone lands them on their own loopback.
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? "(unset — defaults to localhost:3000)",
  };

  return NextResponse.json({
    signedIn: true,
    role: session.role,
    identifier: session.identifier,
    // Distinguishes a missing key from a rejected one from a blocked network,
    // which are three different fixes.
    paystack: await paystackReachability(),
    // If this is false, the token is not being accepted and every table below
    // will read zero — that is the first thing to check.
    env,
    tables: Object.fromEntries(results),
  });
}
