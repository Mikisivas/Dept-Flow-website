import "server-only";

import { SignJWT, jwtVerify } from "jose";
import type { AppRole } from "@/lib/types";

/**
 * Session tokens, signed with the Supabase project's JWT secret.
 *
 * This is the whole reason Dept-Flow can identify accounts by matric number and
 * still use row-level security. Supabase does not care who issued a token, only
 * that it is signed with the project secret and carries the claims PostgREST
 * expects. So we mint our own:
 *
 *   sub  → profiles.id, which is what auth.uid() returns inside every policy
 *   role → "authenticated", which is the Postgres role the policies target
 *
 * The `app_role` claim is ours and carries student/lecturer/hod/admin. It is
 * used for routing and for the API's own authorisation checks — never as the
 * only gate on data, because the policies already scope every row.
 */

const ISSUER = "dept-flow";
const TOKEN_LIFETIME = "12h";

export type SessionClaims = {
  profileId: string;
  role: AppRole;
  /** Matric number or staff ID — for display, never for authorisation. */
  identifier: string;
};

function secret(): Uint8Array {
  const value = process.env.SUPABASE_JWT_SECRET;
  if (!value) {
    throw new Error(
      "SUPABASE_JWT_SECRET is not set. Supabase dashboard → Settings → API → JWT Settings.",
    );
  }
  return new TextEncoder().encode(value);
}

export async function issueSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({
    // "authenticated" is the Postgres role every RLS policy is written for.
    // Without it PostgREST treats the request as anonymous and returns nothing.
    role: "authenticated",
    app_role: claims.role,
    identifier: claims.identifier,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.profileId)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setExpirationTime(TOKEN_LIFETIME)
    .sign(secret());
}

export async function readSession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER });
    if (!payload.sub) return null;

    return {
      profileId: payload.sub,
      role: payload.app_role as AppRole,
      identifier: String(payload.identifier ?? ""),
    };
  } catch {
    // An expired or tampered token is simply not a session. The caller decides
    // what to do about it; there is nothing here worth reporting to the client.
    return null;
  }
}

/** The cookie the session travels in. */
export const SESSION_COOKIE = "dept-flow-session";

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 12,
};
