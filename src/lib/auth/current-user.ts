import "server-only";

import { cookies } from "next/headers";
import { readSession, SESSION_COOKIE, type SessionClaims } from "@/lib/auth/session";

/**
 * The signed-in account, or null.
 *
 * Screens call this to decide what to render. It is not an authorisation
 * check — the row-level security policies are, and they run against the same
 * token regardless of what this returns.
 */
export async function currentUser(): Promise<SessionClaims | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return readSession(token);
}

/** The raw token, for handing to a Supabase client that should read as this user. */
export async function currentAccessToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}
