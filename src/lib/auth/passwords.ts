import "server-only";

import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id, with OWASP's recommended parameters for interactive logins.
 *
 * The database refuses to store anything that is not a modular crypt string, so
 * a plaintext password escaping a code path cannot be written even if this
 * module is bypassed entirely.
 */
const PARAMS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

/**
 * Always runs the full verification, including against a dummy digest when the
 * account does not exist.
 *
 * Returning early on an unknown matric number makes the response measurably
 * faster for numbers that aren't registered, which turns the login form into a
 * way to enumerate who studies here. The matric number format is guessable —
 * CMP/2021/001 through CMP/2021/999 is under a thousand requests.
 */
const DUMMY_DIGEST =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Ry1Ne3sVvGV8xN9hFEcXTNGqvKfXvJKGZ5NqUJZ0k4E";

export async function verifyPassword(
  password: string,
  digest: string | null,
): Promise<boolean> {
  try {
    return await verify(digest ?? DUMMY_DIGEST, password);
  } catch {
    return false;
  }
}

/**
 * Minimum viable rules, deliberately not a maze.
 *
 * Composition requirements push people toward "Password1!" and a sticky note.
 * Length is what actually helps, so length is what is required.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return "Use at least 8 characters.";
  if (password.length > 128) return "That's longer than 128 characters.";
  return null;
}
