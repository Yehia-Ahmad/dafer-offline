#!/usr/bin/env bash
# Nota update (run as root on the server): installs a release tarball made by deploy/make-release.js.
# Usage: update.sh <release-<version>-<commit>.tar.gz>
# Order: backup -> unpack + npm ci -> switch `current` -> restart -> wait for /health (60 s)
#        -> on failure: switch back, restore the pre-update backup, restart -> keep the last 3 releases.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/nota-lib.sh"

KEEP_RELEASES=3
HEALTH_SECONDS=60

require_root
tarball="${1:-}"
[ -n "$tarball" ] || die "usage: update.sh <release.tar.gz>"
[ -f "$tarball" ] || die "file not found: $tarball"

releases="$NOTA_ROOT/releases"
current="$NOTA_ROOT/current"
port="$(backend_port)"

release_json="$(tar -xzOf "$tarball" release.json 2>/dev/null)" || die "not a Nota release (release.json missing)"
version="$(printf '%s' "$release_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).version||"")))')"
commit="$(printf '%s' "$release_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).commit||"")))')"
name="${version}-${commit}"
[[ "$name" =~ ^[A-Za-z0-9._-]+-[A-Za-z0-9._-]+$ ]] || die "bad release name in release.json: $name"
target="$releases/$name"

previous=""
if [ -L "$current" ]; then previous="$(readlink -f "$current")"; fi
if [ -n "$previous" ] && [ "$previous" = "$target" ]; then
  die "release $name is already the current release"
fi

# 1. Backup first. Not possible on the very first install (no data yet).
backup=""
if [ -n "$previous" ]; then
  log "update: backup before the update"
  backup="$("$SCRIPT_DIR/backup.sh" "before-update-${version}")" || die "backup failed, nothing was changed"
  log "update: backup is $backup"
fi

# 2. Unpack next to the final place, install dependencies, then move into place (never a half-built release).
mkdir -p "$releases"
staging="$releases/.staging-$name"
rm -rf "$staging"
mkdir -p "$staging"
tar -xzf "$tarball" -C "$staging"
[ -f "$staging/backend/package-lock.json" ] || die "release has no backend/package-lock.json"
chown -R nota:nota "$staging"
log "update: npm ci --omit=dev"
(cd "$staging/backend" && runuser -u nota -- env HOME=/var/lib/nota npm_config_cache=/var/lib/nota/.npm npm ci --omit=dev --no-audit --no-fund) \
  || { rm -rf "$staging"; die "npm ci failed, the running version was not touched"; }
chown -R root:nota "$staging"
chmod -R u=rwX,g=rX,o= "$staging"
rm -rf "$target"
mv "$staging" "$target"

# 2b. Online Stage 3: a server installed before the customer website has no NOTA_STORE_JWT_SECRET, and the new backend refuses to
#     start without it. Generate it once, only when missing (never replaces an existing secret).
if [ -z "$(env_get NOTA_STORE_JWT_SECRET "$NOTA_BACKEND_ENV")" ]; then
  log "update: generating NOTA_STORE_JWT_SECRET (customer website)"
  env_set NOTA_STORE_JWT_SECRET "$(openssl rand -hex 48)" "$NOTA_BACKEND_ENV"
fi

# 3. Switch and restart. Migrations run when the backend starts.
switch_to() {
  ln -sfn "$1" "$current.new"
  mv -T "$current.new" "$current"
}
log "update: switching current -> $name"
switch_to "$target"
systemctl restart nota-backend

# 4. Wait for /health.
if wait_health "$port" "$HEALTH_SECONDS"; then
  log "update: $name is up"
else
  log "ERROR: /health did not answer within ${HEALTH_SECONDS}s. Rolling back."
  log "update: last lines of the backend log:"
  journalctl -u nota-backend -n 20 --no-pager >&2 || true
  # 5. Roll back. Order matters: with Restart=always systemd restarts a crashing backend every few seconds, and
  #    the old code must never start on data the new migrations already changed. So:
  #    a) stop the service  b) switch back to the old code  c) restore the pre-update data
  #    d) start the service and wait for /health (c and d are restore.sh --rollback, which also works when the
  #    service is already stopped).
  systemctl stop nota-backend || true
  if [ -z "$previous" ]; then
    die "first install failed and there is no previous release to go back to; the backend is stopped. Fix the problem and run update.sh again."
  fi
  switch_to "$previous"
  log "update: restoring $backup (anything entered since the backup is lost)"
  if "$SCRIPT_DIR/restore.sh" --rollback "$backup"; then
    die "UPDATE FAILED and was rolled back to $(basename "$previous"). The shop is running the old version again."
  fi
  die "UPDATE FAILED and the automatic rollback ALSO FAILED. The old code is linked, the backend may be stopped. Backup: $backup. Restore by hand: $SCRIPT_DIR/restore.sh $backup"
fi

# 6. Keep the newest KEEP_RELEASES releases (the current one is never removed).
find "$releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %p\n' \
  | sort -rn | tail -n +"$((KEEP_RELEASES + 1))" | cut -d' ' -f2- \
  | while IFS= read -r old; do
      [ "$(readlink -f "$old")" = "$(readlink -f "$current")" ] && continue
      log "update: removing old release $(basename "$old")"
      rm -rf -- "$old"
    done

log "update: done ($name)"
