import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase clients, in the two shapes this product needs.
 *
 * Dept-Flow does not use Supabase Auth — a student is identified by their
 * matric number, which is neither an email nor a phone. The API issues its own
 * JWT signed with the project's JWT secret, carrying `sub` = profiles.id. That
 * is exactly what `auth.uid()` reads, so every row-level security policy works
 * against our tokens unchanged.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * Reads as the signed-in user. Every query runs under RLS with `auth.uid()`
 * resolving to the account in the token, so a student physically cannot select
 * another student's rows however the query is written.
 *
 * Pass the JWT minted at login. With no token, this is an anonymous client and
 * sees only what the `anon` role is granted — which is nothing.
 */
export function createUserClient(accessToken?: string): SupabaseClient {
  return createClient(requireEnv(SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"), requireEnv(ANON_KEY, "NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: accessToken
      ? { headers: { Authorization: `Bearer ${accessToken}` } }
      : undefined,
  });
}

/**
 * Bypasses row-level security completely.
 *
 * Only for writes the API owns — creating an account, recording a checkpoint
 * submission, clearing a student after a verified payment. It must never be
 * constructed in a file that can reach the browser, and the guard below throws
 * rather than trusting that convention.
 */
export function createServiceClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("The service-role client cannot be created in the browser.");
  }

  return createClient(
    requireEnv(SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
