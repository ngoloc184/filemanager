#!/usr/bin/env bash
# Applies supabase/schema.sql + every migration to a throwaway PostgreSQL
# database (with Supabase stubs) and runs the SQL tests in supabase/tests.
#
# Usage: PGHOST=... PGPORT=... PGUSER=postgres scripts/test-db.sh
# Requires psql and a PostgreSQL 15+ server with pg_trgm, unaccent, pgcrypto.
set -euo pipefail
shopt -s nullglob
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${TEST_DB:-filemanager_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSQL=(psql -v ON_ERROR_STOP=1 -q -X)

psql -X -q -c "drop database if exists ${DB}" -c "create database ${DB}" postgres

run() { "${PSQL[@]}" -d "$DB" -f "$1" >/dev/null; }

run "$ROOT/supabase/tests/00_supabase_stubs.sql"
run "$ROOT/supabase/schema.sql"
for file in "$ROOT"/supabase/migrations/*.sql; do
  echo "migrate $(basename "$file")"
  run "$file"
done

status=0
for test in "$ROOT"/supabase/tests/[1-9]*.sql; do
  echo "test    $(basename "$test")"
  if ! "${PSQL[@]}" -d "$DB" -f "$test"; then status=1; fi
done
exit $status
