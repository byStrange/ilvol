#!/usr/bin/env bash
# Runs the migration chain and the usage-tracking assertions against a
# throwaway Postgres, so schema changes can be verified without touching the
# remote database.
#
#   ./supabase/tests/run.sh
set -euo pipefail

CONTAINER=lf-pgtest
HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS="$HERE/../migrations"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --rm --name "$CONTAINER" -e POSTGRES_PASSWORD=test postgres:15 >/dev/null

for _ in $(seq 1 40); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

docker cp "$HERE/." "$CONTAINER:/tmp/tests/" >/dev/null
docker cp "$MIGRATIONS/." "$CONTAINER:/tmp/migrations/" >/dev/null

docker exec "$CONTAINER" sh -c '
  set -e
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tmp/tests/00_harness.sql
  for f in /tmp/migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tmp/tests/01_usage_tracking_test.sql
'
