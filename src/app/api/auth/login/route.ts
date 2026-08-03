import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/client";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/auth/passwords";
import { issueSession, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "@/lib/auth/session";
import { normaliseMatric } from "@/lib/format";
import type { AppRole } from "@/lib/types";

/**
 * Matric number (or staff ID) + password.
 *
 * One field takes either, so there is no role picker: the system works out
 * which you are from what you typed.
 *
 * Everything here runs server-side. The browser never sees the credential
 * lookup, the digest, or the service-role key — it gets an httpOnly cookie and
 * nothing else.
 */

const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_MINUTES = 15;

/**
 * One message for every wrong-credential case.
 *
 * Distinguishing "no such matric number" from "wrong password" would let anyone
 * enumerate the register — matric numbers are sequential and guessable, so that
 * is a real exposure rather than a theoretical one.
 */
const CREDENTIALS_REJECTED = "That matric number and password don't match. Check both and try again.";

export async function POST(request: Request) {
  let body: { identifier?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const identifier = String(body.identifier ?? "").trim();
  const password = String(body.password ?? "");

  if (!identifier || !password) {
    return NextResponse.json(
      { error: "Enter your matric number and password." },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  // A matric number is normalised to upper case; a staff ID is matched as
  // typed. The database function handles both, so this stays one round trip on
  // a path that runs during checkpoint bursts.
  const lookupValue = identifier.includes("/") ? normaliseMatric(identifier) : identifier;

  const { data: matches, error: lookupError } = await supabase.rpc("resolve_login_identifier", {
    p_identifier: lookupValue,
  });

  if (lookupError) {
    return NextResponse.json(
      { error: "We couldn't reach the server. Try again in a moment." },
      { status: 503 },
    );
  }

  const match = Array.isArray(matches) ? matches[0] : null;

  // Load the digest separately: the lookup function deliberately returns no
  // credential material, because it runs before a session exists.
  const { data: profile } = match
    ? await supabase
        .from("profiles")
        .select("id, role, password_hash, failed_attempts, locked_until, surname, first_name")
        .eq("id", match.profile_id)
        .single()
    : { data: null };

  if (profile?.locked_until && new Date(profile.locked_until) > new Date()) {
    return NextResponse.json(
      {
        error:
          "Too many attempts. Wait a few minutes and try again, or reset your password.",
      },
      { status: 429 },
    );
  }

  // Runs against a dummy digest when there is no account, so an unregistered
  // matric number takes the same time as a wrong password.
  const ok = await verifyPassword(password, profile?.password_hash ?? null);

  if (!ok || !profile || !match) {
    if (profile) {
      const attempts = (profile.failed_attempts ?? 0) + 1;
      await supabase
        .from("profiles")
        .update({
          failed_attempts: attempts,
          locked_until:
            attempts >= LOCKOUT_THRESHOLD
              ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
              : null,
        })
        .eq("id", profile.id);
    }
    return NextResponse.json({ error: CREDENTIALS_REJECTED }, { status: 401 });
  }

  // A deactivated account gets its own message. Telling this student their
  // password is wrong would send them to the reset flow, which cannot help.
  if (match.is_deactivated) {
    return NextResponse.json(
      {
        error: "This account is no longer active. Contact the department office.",
        deactivated: true,
      },
      { status: 403 },
    );
  }

  // A verified bcrypt digest is a correct password stored with the weaker of
  // the two algorithms — the seed uses pgcrypto, which has no Argon2. Upgrading
  // it here migrates each account the first time its owner logs in, with no
  // migration to run and nobody needing to reset anything.
  const upgraded =
    profile.password_hash && needsRehash(profile.password_hash)
      ? await hashPassword(password)
      : null;

  await supabase
    .from("profiles")
    .update({
      failed_attempts: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
      ...(upgraded ? { password_hash: upgraded, password_updated_at: new Date().toISOString() } : {}),
    })
    .eq("id", profile.id);

  const token = await issueSession({
    profileId: profile.id,
    role: profile.role as AppRole,
    identifier: lookupValue,
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);

  return NextResponse.json({
    role: profile.role,
    redirectTo: HOME_FOR_ROLE[profile.role as AppRole],
  });
}

const HOME_FOR_ROLE: Record<AppRole, string> = {
  student: "/dashboard",
  lecturer: "/lecturer",
  hod: "/hod",
  admin: "/admin",
};
