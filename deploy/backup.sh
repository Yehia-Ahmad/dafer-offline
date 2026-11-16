#!/usr/bin/env bash
# Nota backup: mongodump of the nota database, verified, rotated, optionally copied off the server.
# Usage: backup.sh [label]
#   no label:  daily backup  /var/backups/nota/nota-YYYY-MM-DD-HHMM.archive.gz (keeps 14, copied off-server if configured)
#   label:     /var/backups/nota/<label>-YYYY-MM-DD-HHMM.archive.gz (before-update / before-restore; keeps 10 of those)
# The archive path is the only thing printed on stdout. Logs go to stderr (journald under systemd).
# Exit code is non-zero when anything failed, so `systemctl status nota-backup` shows it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/nota-lib.sh"

KEEP_DAILY=14
KEEP_LABELED=10
KEEP_REMOTE=30

require_root
umask 077

label="${1:-}"
if [ -n "$label" ] && ! [[ "$label" =~ ^[A-Za-z0-9._-]+$ ]]; then
  die "bad label: $label"
fi

exec 9>/run/lock/nota-backup.lock
flock -n 9 || die "another backup is already running"

mongo_uri="$(env_get MONGO_URI "$NOTA_BACKEND_ENV")"
[ -n "$mongo_uri" ] || die "MONGO_URI not found in $NOTA_BACKEND_ENV"

mkdir -p "$NOTA_BACKUP_DIR"
stamp="$(date '+%Y-%m-%d-%H%M')"
prefix="${label:-nota}"
archive="$NOTA_BACKUP_DIR/${prefix}-${stamp}.archive.gz"
partial="${archive}.partial"
trap 'rm -f "$partial"' EXIT

log "backup: dumping to $archive"
mongodump --quiet --uri="$mongo_uri" --archive="$partial" --gzip
gzip -t "$partial" || die "backup: archive is not a valid gzip file"
# Reads the archive through mongorestore without writing anything.
mongorestore --quiet --uri="$mongo_uri" --archive="$partial" --gzip --dryRun >/dev/null 2>&1 \
  || die "backup: archive could not be read back (mongorestore --dryRun failed)"
mv -f "$partial" "$archive"
log "backup: ok ($(du -h "$archive" | cut -f1))"

# Local rotation. Daily files and labeled files are rotated separately.
rotate() {
  local pattern="$1" keep="$2" skip="$3" file
  find "$NOTA_BACKUP_DIR" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' \
    | sort -rn | tail -n +"$((keep + 1))" | cut -d' ' -f2- \
    | while IFS= read -r file; do
        [ "$file" = "$skip" ] && continue
        log "backup: removing old backup $file"
        rm -f -- "$file"
      done
}
if [ -z "$label" ]; then
  rotate 'nota-*.archive.gz' "$KEEP_DAILY" "$archive"
else
  rotate 'before-*.archive.gz' "$KEEP_LABELED" "$archive"
fi

status=0
if [ -z "$label" ]; then
  remote="$(env_get NOTA_RCLONE_REMOTE "$NOTA_BACKUP_ENV")"
  if [ -z "$remote" ]; then
    log "WARNING: no off-server copy. Set NOTA_RCLONE_REMOTE in $NOTA_BACKUP_ENV (see docs/deploy/BACKUP_RESTORE_AR.md). A backup on the same server is lost if the server is lost."
  else
    log "backup: copying to $remote"
    if rclone copyto "$archive" "${remote%/}/$(basename "$archive")"; then
      # Keep the newest KEEP_REMOTE archives on the remote.
      if listing="$(rclone lsf --files-only "$remote")"; then
        old="$(printf '%s\n' "$listing" | { grep -E '^nota-.*\.archive\.gz$' || true; } | sort -r | tail -n +"$((KEEP_REMOTE + 1))")"
        while IFS= read -r name; do
          [ -n "$name" ] || continue
          log "backup: removing old remote backup $name"
          rclone deletefile "${remote%/}/$name" || status=1
        done <<<"$old"
      else
        log "backup: could not list the remote for rotation"
        status=1
      fi
    else
      log "ERROR: backup: rclone copy failed (the local backup is fine)"
      status=1
    fi
  fi
fi

printf '%s\n' "$archive"
exit "$status"
