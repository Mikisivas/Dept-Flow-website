import { NextResponse } from "next/server";
import { createServiceClient, createUserClient } from "@/lib/supabase/client";
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
  "whitelist_entries",
  "academic_sessions",
  "dues_periods",
  "compliance_statuses",
  "enrolments",
  "courses",
  "timetable_entries",
  "session_instances",
  "session_scores",
  "payments",
  "waivers",
  "attendance_disputes",
  "registration_disputes",
  "grace_periods",
  "eligibility_lists",
  "notifications",
  "audit_log",
  "risk_predictions",
] as const;

/**
 * Which migrations have landed.
 *
 * The migrations are applied by hand, one file at a time, and missing one is
 * the likeliest way this project breaks. The symptom is unhelpful — PostgREST
 * answers a call to a function that does not exist with a generic error that
 * reaches the screen as "That did not go through." This names the file to run.
 *
 * Read with the service role, because the report is about the database rather
 * than about the caller, and `dept_flow_schema_report` is granted to nothing
 * else.
 */
async function schemaReport() {
  try {
    const { data, error } = await createServiceClient().rpc("dept_flow_schema_report");
    if (error) {
      return {
        upToDate: false,
        problem:
          "Could not read the schema report. If this is a fresh pull, run supabase/migrations/20260728002100_schema_report.sql — it is what answers this question.",
        detail: error.message,
      };
    }
    return data;
  } catch (cause) {
    return {
      upToDate: false,
      problem: "The service-role key is not working.",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

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
    // First thing to read when something misbehaves: a half-applied migration
    // set explains more failures than anything else here.
    schema: await schemaReport(),
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
