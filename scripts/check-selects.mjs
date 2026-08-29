/**
 * Every column the TypeScript asks for, checked against the schema.
 *
 * The bug this exists to catch: a migration drops a column, one `.select()`
 * somewhere still names it, PostgREST rejects the whole query, and the caller
 * does `const { data } = await ...` — so the error goes in the bin and `data`
 * is null. The screen renders an empty list, which is indistinguishable from
 * "this student has no lectures yet".
 *
 * That is the worst shape a bug can have here. It is silent, it is confident,
 * and it is wrong in the direction that matters: a student who attended ten
 * lectures reads 0%. It happened with `checkpoint_mode` after the trust-based
 * migration dropped it, and it survived a full typecheck, lint and build,
 * because none of those know what a database column is.
 *
 * Run against a database that has the schema applied. Reads
 * information_schema, so it checks the real thing rather than a parse of the
 * migrations.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const [, , psqlHost, psqlPort, database] = process.argv;

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

/**
 * `.from("x")` … `.select("a, b, c")`.
 *
 * Deliberately simple. It matches the shape this codebase actually writes and
 * skips anything it cannot read confidently — a check that guesses would
 * produce false alarms, and a false alarm nobody trusts is worse than no
 * check.
 */
const PAIR = /\.from\(\s*"([a-z_]+)"\s*\)([\s\S]{0,400}?)\.select\(\s*(?:"([^"]*)"|`([^`]*)`)/g;

const requests = [];

for (const file of sourceFiles("src")) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(PAIR)) {
    const [, table, between, doubleQuoted, backticked] = match;
    // A `.from()` whose `.select()` belongs to a different chain.
    if (between.includes(".from(")) continue;

    let selected = doubleQuoted ?? backticked ?? "";

    // Embedded relations — `courses(code, title)` — are a join, not a column,
    // and the inner names belong to the other table. Stripped innermost-first
    // and repeatedly, because they nest: `students(profiles(surname))` needs
    // two passes, and one pass leaves a stray bracket that then reads as a
    // column name.
    for (let previous = null; previous !== selected; ) {
      previous = selected;
      selected = selected.replace(/[a-z_]+\s*\([^()]*\)/g, "");
    }

    const columns = selected
      .split(",")
      .map((column) => column.trim().split(":").pop().trim())
      .filter((column) => column && column !== "*");

    const line = source.slice(0, match.index).split("\n").length;
    for (const column of columns) requests.push({ file, line, table, column });
  }
}

if (requests.length === 0) {
  console.error("check-selects found nothing to check — the matcher is broken.");
  process.exit(1);
}

const values = requests
  .map((r) => `('${r.table}','${r.column}')`)
  .join(",");

const sql = `
  select distinct t, c
  from (values ${values}) as asked(t, c)
  where not exists (
    select 1 from information_schema.columns ic
    where ic.table_schema = 'public'
      and ic.table_name = asked.t
      and ic.column_name = asked.c
  )
  -- A view the app reads is as real as a table for this purpose.
  and not exists (
    select 1 from information_schema.columns ic
    where ic.table_name = asked.t and ic.column_name = asked.c
  );
`;

const output = execFileSync(
  "psql",
  ["-h", psqlHost, "-p", psqlPort, "-U", "postgres", "-d", database, "-tAF", "\t", "-c", sql],
  { encoding: "utf8" },
);

const missing = output.trim().split("\n").filter(Boolean);

if (missing.length === 0) {
  console.log(`ok — every column ${requests.length} selects asks for exists`);
  process.exit(0);
}

console.error("\nFAILED — the app selects columns the schema does not have:\n");
for (const row of missing) {
  const [table, column] = row.split("\t");
  const where = requests.filter((r) => r.table === table && r.column === column);
  console.error(`  ${table}.${column}`);
  for (const site of where) console.error(`      ${site.file}:${site.line}`);
}
console.error(
  "\nPostgREST rejects the whole query, and a caller that reads only `data`\n" +
    "gets null and renders an empty screen. Nothing else catches this.\n",
);
process.exit(1);
