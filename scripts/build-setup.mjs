/**
 * Regenerate supabase/setup.sql from supabase/migrations/.
 *
 * setup.sql is the whole schema in one paste-able file, for a fresh Supabase
 * project reached through the SQL Editor rather than a database password. It
 * was maintained by hand until the operational-flow rewrite added eight
 * migrations at once, at which point "remember to also update setup.sql"
 * stopped being a plan.
 *
 * Order is filename order, which is why migrations are numbered.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrations = path.join(root, "supabase", "migrations");
const target = path.join(root, "supabase", "setup.sql");

const RULE = `-- ${"=".repeat(75)}`;

const HEADER = `-- Dept-Flow — complete schema setup
--
-- Generated from supabase/migrations/. Paste the whole file into the Supabase
-- SQL Editor and run it once, on a fresh project.
--
-- Do not edit by hand: run \`npm run build:setup\` instead.
--
-- This exists so the schema can be applied without sharing a database password
-- or a service-role key with anyone. Nothing in here needs either.
--
-- Order matters: types, then tables, then functions, then row-level security,
-- then the function grants that keep PostgREST from publishing them all.
`;

const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();

const parts = [HEADER];
for (const name of files) {
  const body = await readFile(path.join(migrations, name), "utf8");
  parts.push(`\n${RULE}\n-- ${name}\n${RULE}\n\n${body.trimEnd()}\n`);
}

await writeFile(target, parts.join(""), "utf8");
console.log(`setup.sql rebuilt from ${files.length} migrations`);
