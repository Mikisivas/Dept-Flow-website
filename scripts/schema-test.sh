#!/usr/bin/env bash
# Dept-Flow — run the schema tests against a throwaway local Postgres.
#
# supabase/tests/schema_test.sql is written to be pasted into the Supabase SQL
# Editor, which is fine for a one-off check and useless as a habit. This builds
# the schema from setup.sql, loads the seed, runs the suite and reports the
# first failure, so the schema is checked the same way the TypeScript is.
set -uo pipefail

PGBIN=/usr/lib/postgresql/16/bin
PGROOT=${PGROOT:-/var/lib/postgresql/deptflow}
PORT=${PGPORT:-5433}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

export PATH="$PGBIN:$PATH"

if ! pg_isready -h "$PGROOT" -p "$PORT" >/dev/null 2>&1; then
  rm -rf "$PGROOT"; mkdir -p "$PGROOT"; chown postgres:postgres "$PGROOT"
  su postgres -c "PATH=$PGBIN:\$PATH initdb -U postgres -A trust -D $PGROOT/data" >/dev/null 2>&1
  su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGROOT/data -o \"-p $PORT -k $PGROOT -c listen_addresses=''\" -l $PGROOT/pg.log start" >/dev/null 2>&1
  sleep 2
fi

# setup.sql is generated, and testing a stale copy of it tests nothing.
node "$HERE/scripts/build-setup.mjs" >/dev/null

psql -h "$PGROOT" -p "$PORT" -U postgres -tAc "drop database if exists deptflow" >/dev/null
psql -h "$PGROOT" -p "$PORT" -U postgres -tAc "create database deptflow" >/dev/null

run() {
  local label=$1 file=$2
  local out
  out=$(psql -h "$PGROOT" -p "$PORT" -U postgres -d deptflow -v ON_ERROR_STOP=1 -f "$file" 2>&1)
  if printf '%s' "$out" | grep -qE "^psql.*ERROR"; then
    echo "FAILED — $label"
    printf '%s\n' "$out" | grep -E "^psql.*ERROR" | head -5
    exit 1
  fi
  echo "ok — $label"
}

run "harness"  "$HERE/scripts/schema-harness.sql"
run "schema"   "$HERE/supabase/setup.sql"
run "seed"     "$HERE/supabase/seed.sql"

# setup.sql is meant to be pasted into the Supabase SQL Editor, which runs the
# paste as ONE transaction. psql does not, so a statement that is only illegal
# inside a transaction applies cleanly here and fails for the one person
# following the setup guide. `alter type ... add value` followed by a use of
# that value is the specific trap, and it cost a debugging session once.
psql -h "$PGROOT" -p "$PORT" -U postgres -tAc "drop database if exists deptflow_tx" >/dev/null
psql -h "$PGROOT" -p "$PORT" -U postgres -tAc "create database deptflow_tx" >/dev/null
psql -h "$PGROOT" -p "$PORT" -U postgres -d deptflow_tx -q -f "$HERE/scripts/schema-harness.sql" >/dev/null 2>&1
# Matched on "ERROR:" anywhere, NOT on the "psql:file:line:" prefix the other
# runs produce. psql only writes that prefix when reading a file with -f; from
# a pipe it prints a bare "ERROR:", so a prefix-anchored grep here matches
# nothing and reports every schema as transaction-safe. It did exactly that,
# and passed a migration that could not be applied through the SQL Editor.
tx=$( { echo "begin;"; cat "$HERE/supabase/setup.sql"; echo "commit;"; } |
      psql -h "$PGROOT" -p "$PORT" -U postgres -d deptflow_tx 2>&1 |
      grep -E "ERROR:" | head -1 )
psql -h "$PGROOT" -p "$PORT" -U postgres -tAc "drop database if exists deptflow_tx" >/dev/null
if [ -n "$tx" ]; then
  echo "FAILED — schema does not apply as a single transaction (the SQL Editor runs it as one)"
  echo "$tx"
  exit 1
fi
echo "ok — schema applies as one transaction"

# Deliberately NOT ON_ERROR_STOP: the suite is one transaction, so the first
# error aborts it and every statement after reports the abort rather than its
# own result. The first error is the only informative one — anything that greps
# for a later pattern is reading rubble.
out=$(psql -h "$PGROOT" -p "$PORT" -U postgres -d deptflow -f "$HERE/supabase/tests/schema_test.sql" 2>&1)
first=$(printf '%s\n' "$out" | grep -E "^psql.*ERROR" | head -1)
if [ -n "$first" ]; then
  echo
  echo "$first"
  exit 1
fi
# The suite's last statement returns one row per assertion, and psql reports
# how many. Counting NOTICE lines instead would silently read zero the day
# client_min_messages changes.
count=$(printf '%s\n' "$out" | grep -oE "^\\(([0-9]+) rows?\\)$" | tail -1 | tr -dc '0-9')
if [ -z "$count" ] || [ "$count" -eq 0 ]; then
  echo "the suite ran without reporting any assertions — that is a failure, not a pass"
  exit 1
fi
echo
echo "ALL $count SCHEMA ASSERTIONS PASS"

# Every column the TypeScript asks for, against the schema that just applied.
#
# Nothing else in the toolchain can catch a select naming a dropped column:
# typecheck, lint and build all pass, PostgREST rejects the query at runtime,
# and a caller reading only `data` renders an empty screen that looks exactly
# like a student with no lectures. This runs here because here is the only
# place a real schema and the real source are both to hand.
echo
node "$HERE/scripts/check-selects.mjs" "$PGROOT" "$PORT" deptflow || exit 1
