import "server-only";

import { randomInt } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/client";
import { hashPassword, verifyPassword } from "@/lib/auth/passwords";
import { normaliseMatric } from "@/lib/format";

/**
 * Claiming an account against the register.
 *
 * The identity check is matric number + surname + level, matched against an
 * unclaimed `whitelist_entries` row. First and other names are collected and
 * stored as account data and are deliberately NOT matched — a student whose
 * middle name is recorded as "Ngozi" and who types "N." must not be locked out
 * of their own account.
 *
 * The step the client cannot skip is the OTP. Every field the browser sends is
 * re-checked here at account creation, so a request that jumps straight to the
 * last step with a matric number it guessed still has to produce a phone that
 * received a code.
 */

export type RegisterMatch =
  | { outcome: "matched"; matricNo: string; surname: string; level: number; programme: string }
  | { outcome: "no_match" }
  | { outcome: "already_claimed" };

const PROGRAMME_NAMES: Record<string, string> = {
  MTH: "Mathematics",
  CMP: "Computer Science",
  STA: "Statistics",
};

/** How long a verified code stays good for finishing the form. */
const OTP_TTL_MINUTES = 5;
const CLAIM_WINDOW_MINUTES = 20;
/** Per phone, per hour. The expensive step is the one worth capping. */
const OTP_SEND_LIMIT = 5;

export async function checkRegisterMatch(input: {
  matricNo: string;
  surname: string;
  level: number;
}): Promise<RegisterMatch> {
  const db = createServiceClient();
  const matric = normaliseMatric(input.matricNo);

  const { data: entry } = await db
    .from("whitelist_entries")
    .select("matric_no, surname, level, claimed")
    .eq("matric_no", matric)
    .maybeSingle();

  // Surname is compared case-insensitively and trimmed. It is a name a student
  // typed on a phone, not a password.
  if (
    !entry ||
    entry.surname.trim().toLowerCase() !== input.surname.trim().toLowerCase() ||
    entry.level !== input.level
  ) {
    return { outcome: "no_match" };
  }

  if (entry.claimed) return { outcome: "already_claimed" };

  return {
    outcome: "matched",
    matricNo: entry.matric_no,
    surname: entry.surname,
    level: entry.level,
    programme: PROGRAMME_NAMES[matric.split("/")[0]] ?? "",
  };
}

export type SendOtpResult =
  | { outcome: "sent"; expiresAt: string }
  | { outcome: "rate_limited" }
  | { outcome: "phone_taken" };

/**
 * Generate, store hashed, and "deliver".
 *
 * The plaintext code is never in an HTTP response, in any environment — that
 * is the whole reason `send_otp` is an interface rather than a return value.
 * The development implementation writes to the server log; production swaps in
 * an SMS provider and nothing above this line changes.
 */
export async function sendRegistrationOtp(input: {
  matricNo: string;
  phone: string;
}): Promise<SendOtpResult> {
  const db = createServiceClient();
  const matric = normaliseMatric(input.matricNo);

  // One phone, one account. Two students sharing a number would each be able
  // to reset the other's password.
  const { data: taken } = await db
    .from("profiles")
    .select("id")
    .eq("phone", input.phone)
    .maybeSingle();

  if (taken) return { outcome: "phone_taken" };

  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count } = await db
    .from("otp_codes")
    .select("id", { count: "exact", head: true })
    .eq("phone", input.phone)
    .gte("created_at", since);

  if ((count ?? 0) >= OTP_SEND_LIMIT) return { outcome: "rate_limited" };

  // randomInt, not Math.random. A predictable code is a bypassed phone check.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();

  const { error } = await db.from("otp_codes").insert({
    purpose: "registration",
    matric_no: matric,
    phone: input.phone,
    code_hash: await hashPassword(code),
    expires_at: expiresAt,
  });

  if (error) throw new Error(`Could not send a code: ${error.message}`);

  await deliverOtp(input.phone, code);

  return { outcome: "sent", expiresAt };
}

/**
 * The single delivery seam. Everything above it is production code.
 *
 * Development writes to the server log. It is the one place a plaintext code
 * exists after generation, and it must never become a response body, a toast,
 * or a query string.
 */
async function deliverOtp(phone: string, code: string): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    // Termii / Africa's Talking goes here. Failing loudly beats a student
    // waiting for a code that was never going to arrive.
    throw new Error("No SMS provider is configured for production.");
  }
  console.info(`\n  [dev OTP] ${phone} → ${code}\n`);
}

export type VerifyOtpResult = { ok: true } | { ok: false; reason: string };

export async function verifyRegistrationOtp(input: {
  phone: string;
  code: string;
}): Promise<VerifyOtpResult> {
  const db = createServiceClient();

  const { data: row } = await db
    .from("otp_codes")
    .select("id, code_hash, expires_at, attempts, max_attempts, consumed_at")
    .eq("phone", input.phone)
    .eq("purpose", "registration")
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) return { ok: false, reason: "Ask for a new code." };
  if (row.attempts >= row.max_attempts) {
    return { ok: false, reason: "Too many tries. Ask for a new code." };
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    return { ok: false, reason: "That code has expired. Ask for a new one." };
  }

  const ok = await verifyPassword(input.code, row.code_hash);

  if (!ok) {
    await db
      .from("otp_codes")
      .update({ attempts: row.attempts + 1 })
      .eq("id", row.id);
    return { ok: false, reason: "That code isn't right." };
  }

  // Consuming it is what later proves this phone was reached. The account
  // creation step looks for exactly this row.
  await db.from("otp_codes").update({ consumed_at: new Date().toISOString() }).eq("id", row.id);

  return { ok: true };
}

export type CreateAccountResult =
  | { outcome: "created"; profileId: string; matricNo: string }
  | { outcome: "not_verified" }
  | { outcome: "no_match" }
  | { outcome: "already_claimed" };

/**
 * Create the account, re-checking everything the browser claimed.
 *
 * Nothing from the earlier steps is trusted: the register match is redone, and
 * a consumed registration code for this matric number and phone must exist
 * inside the claim window. Without that second condition the whole flow would
 * be a POST away from registering anyone in the department.
 */
export async function createStudentAccount(input: {
  matricNo: string;
  surname: string;
  level: number;
  firstName: string;
  otherNames: string | null;
  phone: string;
  password: string;
}): Promise<CreateAccountResult> {
  const db = createServiceClient();
  const matric = normaliseMatric(input.matricNo);

  const match = await checkRegisterMatch({
    matricNo: matric,
    surname: input.surname,
    level: input.level,
  });

  if (match.outcome !== "matched") return { outcome: match.outcome };

  const since = new Date(Date.now() - CLAIM_WINDOW_MINUTES * 60_000).toISOString();
  const { data: verified } = await db
    .from("otp_codes")
    .select("id")
    .eq("purpose", "registration")
    .eq("matric_no", matric)
    .eq("phone", input.phone)
    .not("consumed_at", "is", null)
    .gte("consumed_at", since)
    .limit(1)
    .maybeSingle();

  if (!verified) return { outcome: "not_verified" };

  const { data: entry } = await db
    .from("whitelist_entries")
    .select("id, academic_session_id")
    .eq("matric_no", matric)
    .single();

  const { data: profile, error: profileError } = await db
    .from("profiles")
    .insert({
      role: "student",
      surname: match.surname,
      first_name: input.firstName.trim(),
      other_names: input.otherNames?.trim() || null,
      phone: input.phone,
      password_hash: await hashPassword(input.password),
      password_updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (profileError || !profile) {
    throw new Error(`Could not create the account: ${profileError?.message}`);
  }

  const { error: studentError } = await db.from("students").insert({
    id: profile.id,
    matric_no: matric,
    level: match.level,
    whitelist_entry_id: entry?.id ?? null,
  });

  if (studentError) {
    // The profile without a student row is an account that can log in and has
    // no record. Undo it rather than leave that behind.
    await db.from("profiles").delete().eq("id", profile.id);
    throw new Error(`Could not create the student record: ${studentError.message}`);
  }

  // Claimed last, and conditionally: two people racing the same matric number
  // means the second update matches no rows, and that student is rolled back
  // rather than silently sharing the register entry.
  const { data: claimed } = await db
    .from("whitelist_entries")
    .update({ claimed: true, claimed_by: profile.id, claimed_at: new Date().toISOString() })
    .eq("matric_no", matric)
    .eq("claimed", false)
    .select("id");

  if (!claimed || claimed.length === 0) {
    await db.from("students").delete().eq("id", profile.id);
    await db.from("profiles").delete().eq("id", profile.id);
    return { outcome: "already_claimed" };
  }

  // Uncleared from the first second. Attendance records from day one and
  // counts from the day they clear — that is the entire mechanism, and it
  // starts here rather than at their first lecture.
  if (entry?.academic_session_id) {
    await db.from("compliance_statuses").insert({
      student_id: profile.id,
      academic_session_id: entry.academic_session_id,
      state: "uncleared",
    });
  }

  return { outcome: "created", profileId: profile.id, matricNo: matric };
}
