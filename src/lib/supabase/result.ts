import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Reading a query result without discarding the reason it failed.
 *
 * THE BUG THIS EXISTS TO STOP
 *
 * Almost every read in this codebase was written as `const { data } = await
 * db...`, which throws the error away. PostgREST answers a rejected query with
 * `data: null` beside an error object, so a failed query and an empty table
 * arrive as the same value — and the screen renders the empty one, confidently,
 * with nothing to say about itself.
 *
 * That is not hypothetical. `students` has two foreign keys to `profiles`, so a
 * bare `profiles(...)` embed was ambiguous and PostgREST refused it. The HOD
 * dashboard read "0 students across the active session" against a database
 * holding three, and the only hint on the whole page was a count beside it that
 * happened to use no embed. It cost most of a day.
 *
 * An empty department and a department the query could not read are different
 * facts, and exactly one of them is ever true.
 *
 * WHY IT THROWS
 *
 * Because there is no honest screen to render. An empty list says "there is
 * nothing here", which is a claim, and a failed query has not earned it. Next
 * turns the throw into an error boundary and writes the message to the server
 * log, where somebody can act on it. This system's whole posture is that a
 * screen must never assert something the server did not confirm, and a silent
 * zero asserts a great deal.
 *
 * WHY IT RETURNS THE RESULT UNCHANGED
 *
 * So that adopting it is a wrap and never a rewrite. `const { data: x } = await
 * db...` becomes `const { data: x } = ok(await db..., "x")` — the destructure,
 * the chain, the `?? []` that follows, all untouched. A refactor that reshaped
 * a hundred and forty call sites would carry more risk than the bug it fixes,
 * and every reshaped line is a line nobody diffed properly.
 *
 * WHAT IT DELIBERATELY LEAVES ALONE
 *
 * Callers that inspect `error` and decide for themselves. `apply_payment`
 * recording money whose side effects failed, and the routes that turn a
 * database message into a sentence on screen, both handle failure better than a
 * throw would.
 *
 * Three kinds of write are unchecked on purpose, and are not oversights:
 *
 *   - Rollback cleanup on a path that is already failing — the deletes that
 *     undo a half-created account. Throwing there replaces the real error with
 *     a worse one and tells nobody why.
 *   - Retry bookkeeping that heals itself: `schedule_payment_check`, pruning a
 *     push subscription a browser has abandoned, `last_checked_at`. A write
 *     that does not land leaves the row in its previous state and the next
 *     sweep picks it up, which is the outcome the throw would be asking for.
 *   - The two writes on the login path. A throw there would refuse a valid
 *     login over bookkeeping, and answer differently depending on whether the
 *     account exists — the enumeration that route spends a dummy digest to
 *     prevent. Those log instead, which is the same refusal to discard.
 *
 * Everything else that writes and then reports success is checked.
 */
export class QueryFailed extends Error {
  // Written out rather than declared as constructor parameter properties: the
  // test runner strips types instead of compiling them, and that syntax needs a
  // compiler. A field is a field either way.
  readonly what: string;
  readonly cause: PostgrestError;

  constructor(what: string, cause: PostgrestError) {
    super(`Reading ${what} failed: ${cause.message}`);
    this.name = "QueryFailed";
    this.what = what;
    this.cause = cause;
  }
}

/**
 * PostgREST's "I asked for exactly one row and got none".
 *
 * `.single()` reports that as an error, and it usually is not one: "there is no
 * active session yet" and "the query was malformed" arrive down the same
 * channel, and only the second is a failure. So it passes through, which is
 * what every `.single()` caller here already assumed would happen.
 *
 * `.maybeSingle()` says the same thing without the detour and is the better
 * thing to write. This exists so that adopting `ok()` changes no behaviour that
 * was already correct.
 */
const NO_ROWS = "PGRST116";

function check(result: unknown, what: string): void {
  if (!result || typeof result !== "object" || !("error" in result)) return;

  const error = (result as { error: PostgrestError | null }).error;
  if (!error || error.code === NO_ROWS) return;

  throw new QueryFailed(what, error);
}

/**
 * One query result, checked and handed straight back.
 *
 * `what` is for whoever reads the log afterwards. "the HOD's standings" beats a
 * bare Postgres message with no clue which of forty queries on the page
 * produced it.
 */
export function ok<T>(result: T, what: string): T {
  check(result, what);
  return result;
}

/**
 * A whole `Promise.all` of them, checked and handed straight back.
 *
 * The tuple keeps its types, so the destructure on the left is unchanged. The
 * index goes into the message because one label covers the batch, and "query 3"
 * is the difference between reading the right line and reading all of them.
 *
 * Entries that are not query results — a plain promise awaited alongside — are
 * skipped rather than rejected. Batches here mix the two freely.
 */
export function allOk<T extends readonly unknown[]>(results: T, what: string): T {
  results.forEach((result, index) => check(result, `${what} (query ${index + 1})`));
  return results;
}
