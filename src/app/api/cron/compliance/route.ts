import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * The nightly compliance transition, for hosts without pg_cron.
 *
 * pg_cron inside Supabase is the better path and is documented in the
 * migration: one less moving part, no shared secret, and it keeps running while
 * the web deployment is down. This exists for hosts that cannot do that.
 *
 * Safe to call repeatedly. The transitions are idempotent by their own
 * conditions — before the deadline `begin_pending_verification` moves nobody,
 * and `lock_after_buffer` only touches students whose buffer has genuinely
 * elapsed — rather than by remembering whether they ran.
 */
export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;

  // Refuses rather than running unauthenticated. This endpoint can lock a whole
  // department out of paying, so an unset secret is a configuration fault, not
  // a reason to skip the check.
  if (!expected) {
    console.error("CRON_SECRET is not set — refusing to run the compliance transition");
    return NextResponse.json({ error: "Not configured." }, { status: 500 });
  }

  const offered = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!matches(offered, expected)) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  const db = createServiceClient();
  const { data, error } = await db.rpc("advance_compliance_states");

  if (error) {
    console.error("compliance transition failed", error);
    return NextResponse.json({ error: "The transition failed." }, { status: 503 });
  }

  const result = Array.isArray(data) ? data[0] : data;

  return NextResponse.json({
    movedToPending: result?.moved_to_pending ?? 0,
    locked: result?.locked ?? 0,
  });
}

function matches(offered: string, expected: string): boolean {
  const a = Buffer.from(offered, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Length first: timingSafeEqual throws on a mismatch, and a length is not a
  // secret worth protecting.
  return a.length === b.length && timingSafeEqual(a, b);
}
