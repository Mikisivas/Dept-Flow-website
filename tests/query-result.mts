/**
 * Checking a query result instead of discarding it.
 *
 * The helper is one small function reached from a hundred and forty call sites,
 * so what matters is the boundary: a real failure has to stop the render, and
 * everything that is not a failure has to pass through untouched. Getting the
 * second half wrong would turn every empty table into an error page.
 *
 *   npm run test:result
 */

import { allOk, ok, QueryFailed } from "../src/lib/supabase/result.ts";

let failed = 0;
function check(what: string, passed: boolean) {
  console.log(`${passed ? "ok  " : "FAIL"} — ${what}`);
  if (!passed) failed++;
}

function threw(run: () => unknown): QueryFailed | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof QueryFailed ? error : null;
  }
}

const failure = { message: "column x does not exist", details: "", hint: "", code: "42703", name: "" };

// --- what passes through ----------------------------------------------------

const rows = { data: [{ id: "a" }], error: null };
check("a successful read is handed back as the same object", ok(rows, "rows") === rows);

const empty = { data: [], error: null };
check("an empty table is not a failure", ok(empty, "rows") === empty);
check("a null row from maybeSingle is not a failure", ok({ data: null, error: null }, "row").data === null);

check(
  "PGRST116 passes through — .single() reporting no rows is not a broken query",
  ok({ data: null, error: { ...failure, code: "PGRST116", message: "no rows" } }, "row").data === null,
);

check("a value that is not a query result is left alone", ok(42, "n") === 42);
check("null is left alone", ok(null, "n") === null);
check("a plain array awaited alongside queries is left alone", allOk([[1, 2, 3]], "list")[0].length === 3);

// --- what stops the render --------------------------------------------------

const caught = threw(() => ok({ data: null, error: failure }, "the register"));
check("a refused query throws", caught !== null);
check("and names what was being read", caught?.message.includes("the register") === true);
check("and carries the database's own message", caught?.message.includes("column x does not exist") === true);
check("and keeps the original error for a log", caught?.cause.code === "42703");

check(
  "data beside an error is still a failure — PostgREST sends null, but the error wins",
  threw(() => ok({ data: [], error: failure }, "rows")) !== null,
);

// --- batches ----------------------------------------------------------------

const batch = [rows, empty] as const;
check("a clean batch is handed back as the same tuple", allOk(batch, "a, b") === batch);

const middle = threw(() => allOk([rows, { data: null, error: failure }, empty], "students, marks, scores"));
check("one bad query in a batch throws", middle !== null);
check(
  "and says which position it was, so the right line gets read",
  middle?.message.includes("query 2") === true,
);

console.log(failed === 0 ? "\nALL QUERY RESULT CHECKS PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
