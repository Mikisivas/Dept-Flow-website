import "server-only";

import { randomInt } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/client";
import { hashPassword, verifyPassword } from "@/lib/auth/passwords";
import { normaliseMatric } from "@/lib/format";

/**
 * Resetting a forgotten password.
 *
 * Matric number → code to the phone already on the account → new password.
 *
 * The phone is never taken from the form. Letting whoever knows a matric
 * number nominate the destination would turn this into the account-takeover
 * path it exists to prevent — so the number is looked up from the profile and
 * only ever returned masked.
 *
 * `purpose = 'password_reset'` keeps these codes in their own namespace. A
 * registration code must not be spendable here, or an attacker who triggered a
 * registration OTP for an unclaimed matric number could reset a real account
 * with it.
 */

const OTP_TTL_MINUTES = 5;
const OTP_SEND_LIMIT = 5;
const MIN_PASSWORD_LENGTH = 8;

export type StartResetResult =
  | { outcome: "sent"; maskedPhone: string; expiresAt: string }
  | { outcome: "rate_limited" }
  /** Deliberately indistinguishable from success at the route. See below. */
  | { outcome: "no_account" };

function maskPhone(phone: string): string {
  const digits = phone.replace(/[^0-9+]/g, "");
  if (digits.length < 7) return "•••";
  return `${digits.slice(0, 7)} ••• ${digits.slice(-4)}`;
}

export async function startPasswordReset(matricNo: string): Promise<StartResetResult> {
  const db = createServiceClient();
  const matric = normaliseMatric(matricNo);

  const { data: student } = await db
    .from("students")
    .select("id, status, profiles(phone)")
    .eq("matric_no", matric)
    .maybeSingle();

  const profile = Array.isArray(student?.profiles) ? student?.profiles[0] : student?.profiles;
  const phone = profile?.phone as string | undefined;

  // A deactivated account is not resettable, and is reported the same way as a
  // number that does not exist. "That account is deactivated" told to whoever
  // types a matric number is a fact about a student they may have no business
  // knowing.
  if (!student || student.status === "deactivated" || !phone) {
    return { outcome: "no_account" };
  }

  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count } = await db
    .from("otp_codes")
    .select("id", { count: "exact", head: true })
    .eq("phone", phone)
    .eq("purpose", "password_reset")
    .gte("created_at", since);

  if ((count ?? 0) >= OTP_SEND_LIMIT) return { outcome: "rate_limited" };

  // randomInt, not Math.random. A predictable code is a bypassed phone check.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();

  const { error } = await db.from("otp_codes").insert({
    purpose: "password_reset",
    matric_no: matric,
    profile_id: student.id,
    phone,
    code_hash: await hashPassword(code),
    expires_at: expiresAt,
  });

  if (error) throw new Error(`Could not send a code: ${error.message}`);

  await deliverOtp(phone, code);

  return { outcome: "sent", maskedPhone: maskPhone(phone), expiresAt };
}

/**
 * The single delivery seam, the same one registration uses.
 *
 * Development writes to the server log. It is the one place a plaintext code
 * exists after generation, and it must never become a response body, a toast,
 * or a query string.
 */
async function deliverOtp(phone: string, code: string): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("No SMS provider is configured for production.");
  }
  console.info(`\n  [dev reset OTP] ${phone} → ${code}\n`);
}

export type CompleteResetResult =
  | { outcome: "changed" }
  | { outcome: "bad_code"; reason: string }
  | { outcome: "weak_password" };

/**
 * Verify and change, in one call.
 *
 * Deliberately not two: a "verify" step that answers yes and leaves the client
 * to ask for the change is a step an attacker can skip. The code is spent at
 * the moment the password moves, and nothing between the two can be replayed.
 */
export async function completePasswordReset(input: {
  matricNo: string;
  code: string;
  password: string;
}): Promise<CompleteResetResult> {
  if (input.password.length < MIN_PASSWORD_LENGTH) return { outcome: "weak_password" };

  const db = createServiceClient();
  const matric = normaliseMatric(input.matricNo);

  const { data: row } = await db
    .from("otp_codes")
    .select("id, profile_id, code_hash, expires_at, attempts, max_attempts")
    .eq("matric_no", matric)
    .eq("purpose", "password_reset")
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) return { outcome: "bad_code", reason: "Ask for a new code." };
  if (row.attempts >= row.max_attempts) {
    return { outcome: "bad_code", reason: "Too many tries. Ask for a new code." };
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    return { outcome: "bad_code", reason: "That code has expired. Ask for a new one." };
  }

  if (!(await verifyPassword(input.code, row.code_hash))) {
    await db
      .from("otp_codes")
      .update({ attempts: row.attempts + 1 })
      .eq("id", row.id);
    return { outcome: "bad_code", reason: "That code isn't right." };
  }

  await db
    .from("profiles")
    .update({
      password_hash: await hashPassword(input.password),
      password_updated_at: new Date().toISOString(),
      // A student resetting their password is very often a student who has been
      // locked out by failed attempts. Leaving the lockout in place would mean
      // the reset appears to work and the login still refuses them.
      failed_attempts: 0,
      locked_until: null,
    })
    .eq("id", row.profile_id);

  await db.from("otp_codes").update({ consumed_at: new Date().toISOString() }).eq("id", row.id);

  return { outcome: "changed" };
}

// ---------------------------------------------------------------------------
// Changing a password while signed in
// ---------------------------------------------------------------------------

export type ChangePasswordResult =
  | { outcome: "changed" }
  | { outcome: "wrong_current" }
  | { outcome: "weak_password" };

/**
 * Different from a reset, and deliberately so: it asks for the current
 * password rather than sending a code.
 *
 * The current password is what stops a borrowed unlocked phone from becoming a
 * permanent takeover. A signed-in session alone is not proof of identity —
 * that is exactly the situation this check exists for.
 */
export async function changePassword(input: {
  profileId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<ChangePasswordResult> {
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) return { outcome: "weak_password" };

  const db = createServiceClient();

  const { data: profile } = await db
    .from("profiles")
    .select("password_hash")
    .eq("id", input.profileId)
    .maybeSingle();

  if (!profile?.password_hash) return { outcome: "wrong_current" };
  if (!(await verifyPassword(input.currentPassword, profile.password_hash))) {
    return { outcome: "wrong_current" };
  }

  await db
    .from("profiles")
    .update({
      password_hash: await hashPassword(input.newPassword),
      password_updated_at: new Date().toISOString(),
    })
    .eq("id", input.profileId);

  return { outcome: "changed" };
}

// ---------------------------------------------------------------------------
// Changing the phone number on an account
// ---------------------------------------------------------------------------

export type StartPhoneChangeResult =
  | { outcome: "sent"; expiresAt: string }
  | { outcome: "rate_limited" }
  | { outcome: "invalid" }
  | { outcome: "phone_taken" };

const PHONE_PATTERN = /^\+234[0-9]{10}$/;

/**
 * The code goes to the NEW number, not the old one.
 *
 * That is what the check is for: proving the person asking can actually
 * receive messages at the number they are moving to. Sending it to the old one
 * would prove only that they are already signed in, which is not in question.
 */
export async function startPhoneChange(input: {
  profileId: string;
  phone: string;
}): Promise<StartPhoneChangeResult> {
  const phone = input.phone.replace(/[^0-9+]/g, "");
  if (!PHONE_PATTERN.test(phone)) return { outcome: "invalid" };

  const db = createServiceClient();

  // One phone, one account. Two students sharing a number would each be able
  // to reset the other's password.
  const { data: taken } = await db
    .from("profiles")
    .select("id")
    .eq("phone", phone)
    .maybeSingle();

  if (taken && taken.id !== input.profileId) return { outcome: "phone_taken" };

  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count } = await db
    .from("otp_codes")
    .select("id", { count: "exact", head: true })
    .eq("phone", phone)
    .eq("purpose", "phone_change")
    .gte("created_at", since);

  if ((count ?? 0) >= OTP_SEND_LIMIT) return { outcome: "rate_limited" };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();

  const { error } = await db.from("otp_codes").insert({
    purpose: "phone_change",
    profile_id: input.profileId,
    phone,
    code_hash: await hashPassword(code),
    expires_at: expiresAt,
  });

  if (error) throw new Error(`Could not send a code: ${error.message}`);

  await deliverOtp(phone, code);

  return { outcome: "sent", expiresAt };
}

export type CompletePhoneChangeResult = { outcome: "changed" } | { outcome: "bad_code"; reason: string };

export async function completePhoneChange(input: {
  profileId: string;
  phone: string;
  code: string;
}): Promise<CompletePhoneChangeResult> {
  const db = createServiceClient();
  const phone = input.phone.replace(/[^0-9+]/g, "");

  const { data: row } = await db
    .from("otp_codes")
    .select("id, code_hash, expires_at, attempts, max_attempts")
    .eq("profile_id", input.profileId)
    .eq("phone", phone)
    .eq("purpose", "phone_change")
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) return { outcome: "bad_code", reason: "Ask for a new code." };
  if (row.attempts >= row.max_attempts) {
    return { outcome: "bad_code", reason: "Too many tries. Ask for a new code." };
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    return { outcome: "bad_code", reason: "That code has expired. Ask for a new one." };
  }

  if (!(await verifyPassword(input.code, row.code_hash))) {
    await db
      .from("otp_codes")
      .update({ attempts: row.attempts + 1 })
      .eq("id", row.id);
    return { outcome: "bad_code", reason: "That code isn't right." };
  }

  await db.from("profiles").update({ phone }).eq("id", input.profileId);
  await db.from("otp_codes").update({ consumed_at: new Date().toISOString() }).eq("id", row.id);

  return { outcome: "changed" };
}
