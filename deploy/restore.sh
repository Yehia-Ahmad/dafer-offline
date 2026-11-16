#!/usr/bin/env bash
# Nota restore (manual): replaces the database with a backup archive.
# Usage: restore.sh <archive.archive.gz>
# Internal use by update.sh rollback: restore.sh --rollback <archive>  (no prompt, no safety backup, sessions are kept)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/nota-lib.sh"

rollback=0
if [ "${1:-}" = "--rollback" ]; then
  rollback=1
  shift
fi
archive="${1:-}"
[ -n "$archive" ] || die "usage: restore.sh <archive>"

require_root
[ -f "$archive" ] || die "archive not found: $archive"
gzip -t "$archive" || die "archive is not a valid gzip file: $archive"

mongo_uri="$(env_get MONGO_URI "$NOTA_BACKEND_ENV")"
[ -n "$mongo_uri" ] || die "MONGO_URI not found in $NOTA_BACKEND_ENV"
domain="$(shop_domain)"
port="$(backend_port)"
db_name="$(printf '%s' "$mongo_uri" | sed -E 's#^mongodb(\+srv)?://[^/]+/([^?]*).*#\2#')"
[ -n "$db_name" ] || die "could not read the database name from MONGO_URI"

if [ "$rollback" -eq 0 ]; then
  echo "This REPLACES all data of $domain with the backup:"
  echo "  $archive"
  echo "Everything entered after that backup is lost, and every user must sign in again."
  printf 'To continue, type the domain (%s): ' "$domain"
  read -r typed
  [ "$typed" = "$domain" ] || die "domain did not match, nothing was changed"

  log "restore: taking a safety backup first"
  safety="$("$SCRIPT_DIR/backup.sh" before-restore)" || die "safety backup failed, nothing was changed"
  log "restore: safety backup is $safety"
fi

log "restore: stopping nota-backend"
systemctl stop nota-backend

log "restore: restoring (--drop)"
if ! mongorestore --quiet --uri="$mongo_uri" --archive="$archive" --gzip --drop --nsInclude="${db_name}.*"; then
  log "ERROR: mongorestore failed. The backend is left STOPPED. ${safety:+The safety backup is $safety.}"
  exit 1
fi

if [ "$rollback" -eq 0 ]; then
  # Every token issued before now is refused, so everybody signs in again (the data under them changed).
  env_set NOTA_SESSIONS_VALID_AFTER "$(date +%s%3N)" "$NOTA_BACKEND_ENV"
fi

log "restore: starting nota-backend"
systemctl start nota-backend
if wait_health "$port" 60; then
  log "restore: done, /health is up"
else
  die "restore finished but /health did not answer within 60 s: check 'journalctl -u nota-backend -n 100'"
fi
