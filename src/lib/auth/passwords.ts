import "server-only";

import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { verify as bcryptVerify } from "@node-rs/bcrypt";

/**
 * Argon2id for anything this application hashes, with OWASP's recommended
 * parameters for interactive logins.
 *
 * Verification, though, has to accept bcrypt as well. The development seed
 * hashes with pgcrypto — which has no Argon2 — so every seeded account carries
 * a `$2a$` digest. An Argon2-only verifier throws on those and the throw looks
 * exactly like a wrong password, which is a genuinely confusing failure: the
 * credentials are right, the database is right, and the login still says no.
 *
 * The database's check constraint always accepted both. This is the half that
 * did not.
 */
const PARAMS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return argonHash(password, PARAMS);
}

/** Which algorithm produced a digest, read from its modular crypt prefix. */
export function digestAlgorithm(digest: string): "argon2" | "bcrypt" | "unknown" {
  if (digest.startsWith("$argon2")) return "argon2";
  if (/^\$2[aby]\$/.test(digest)) return "bcrypt";
  return "unknown";
}

/**
 * Always runs a full verification, including against a dummy digest when the
 * account does not exist.
 *
 * Returning early on an unknown matric number makes the response measurably
 * faster for numbers that aren't registered, which turns the login form into a
 * way to enumerate who studies here. Matric numbers are sequential — CMP/2021/001
 * through CMP/2021/999 is under a thousand requests.
 */
const DUMMY_DIGEST =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Ry1Ne3sVvGV8xN9hFEcXTNGqvKfXvJKGZ5NqUJZ0k4E";

export async function verifyPassword(
  password: string,
  digest: string | null,
): Promise<boolean> {
  const target = digest ?? DUMMY_DIGEST;

  try {
    switch (digestAlgorithm(target)) {
      case "bcrypt":
        return await bcryptVerify(password, target);
      case "argon2":
        return await argonVerify(target, password);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * True when a digest should be replaced after a successful login.
 *
 * A bcrypt hash that verifies is a correct password stored with the weaker of
 * the two algorithms. Re-hashing on the way past upgrades each account the
 * first time its owner logs in, without a migration and without anyone needing
 * to reset anything.
 */
export function needsRehash(digest: string): boolean {
  return digestAlgorithm(digest) !== "argon2";
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
