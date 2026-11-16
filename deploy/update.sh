#!/usr/bin/env bash
# Nota update (run as root on the server): installs a release tarball made by deploy/make-release.js.
# Usage: update.sh <release-<version>-<commit>.tar.gz>
# Order: checks -> backup -> unpack + npm ci -> switch `current` -> restart the backend, wait for /health (60 s)
#        -> restart the storefront, wait for its /health and for GET / (200, or the closed page) (60 s)
#        -> on any failure: stop both, switch back, restore the pre-update backup, start both again -> keep the last 3 releases.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/nota-lib.sh"

KEEP_RELEASES=3
HEALTH_SECONDS=60
STOREFRONT_SECONDS=60

require_root
tarball="${1:-}"
[ -n "$tarball" ] || die "usage: update.sh <release.tar.gz>"
[ -f "$tarball" ] || die "file not found: $tarball"

releases="$NOTA_ROOT/releases"
current="$NOTA_ROOT/current"
port="$(backend_port)"
sf_port="$(storefront_port)"

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

# 0. Online Stage 5B: a release now holds the admin app (frontend/admin) and the storefront. Refuse an old-format tarball, and a server
#    whose one-time setup (systemd unit, nginx /admin/ and storefront proxy) was never re-run, before anything is touched.
tar_list="$(tar -tzf "$tarball" 2>/dev/null)" || die "cannot read $tarball"
printf '%s\n' "$tar_list" | grep -qx 'frontend/admin/index.html' || die "this release has no frontend/admin/index.html: it was made by an older make-release.js. Build it again."
printf '%s\n' "$tar_list" | grep -qx 'storefront/server/server.mjs' || die "this release has no storefront/server/server.mjs: it was made by an older make-release.js. Build it again."
if [ ! -f /etc/systemd/system/nota-storefront.service ] || ! grep -q 'location /admin/' /etc/nginx/sites-available/nota 2>/dev/null; then
  die "this server was set up before the customer website. Upload the new deploy/ folder and run 'bash setup-server.sh <domain> <email>' once (it is safe to re-run), then run this update again."
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

# 2b2. Online Stage 6A: the VAPID key pair for phone notifications, generated once when missing (see ensure_vapid).
ensure_vapid "$target/backend"

# 2c. The storefront's environment is written by setup-server.sh; if it is missing, setup was not re-run.
[ -f "$NOTA_STOREFRONT_ENV" ] || die "$NOTA_STOREFRONT_ENV is missing: run setup-server.sh again (see above)"

# 3. Switch and restart. Migrations run when the backend starts.
switch_to() {
  ln -sfn "$1" "$current.new"
  mv -T "$current.new" "$current"
}
log "update: switching current -> $name"
switch_to "$target"
systemctl restart nota-backend

# 4. Wait for the backend's /health, then restart the storefront (it renders from the backend) and wait for it: its own /health and
#    GET / answering 200 or the closed page (503 + X-Nota-Closed). A 503 without that header means it cannot reach the backend.
failed=""
if wait_health "$port" "$HEALTH_SECONDS"; then
  log "update: backend is up"
  systemctl restart nota-storefront
  if wait_storefront "$sf_port" "$STOREFRONT_SECONDS"; then
    log "update: storefront is up"
  else
    failed="storefront"
  fi
else
  failed="backend"
fi

if [ -n "$failed" ]; then
  if [ "$failed" = "backend" ]; then
    log "ERROR: backend /health did not answer within ${HEALTH_SECONDS}s. Rolling back."
  else
    log "ERROR: the storefront did not become healthy within ${STOREFRONT_SECONDS}s. Rolling back."
  fi
  log "update: last lines of the backend log:"
  journalctl -u nota-backend -n 20 --no-pager >&2 || true
  log "update: last lines of the storefront log:"
  journalctl -u nota-storefront -n 20 --no-pager >&2 || true
  # 5. Roll back both services. Order matters: with Restart=always systemd restarts a crashing service every few seconds, and
  #    the old code must never start on data the new migrations already changed. So:
  #    a) stop BOTH services  b) switch back to the old code  c) restore the pre-update data
  #    d) start the backend and wait for /health (c and d are restore.sh --rollback, which also works when the service is
  #    already stopped)  e) start the storefront again and wait for it.
  systemctl stop nota-storefront || true
  systemctl stop nota-backend || true
  if [ -z "$previous" ]; then
    die "first install failed and there is no previous release to go back to; both services are stopped. Fix the problem and run update.sh again."
  fi
  switch_to "$previous"
  log "update: restoring $backup (anything entered since the backup is lost)"
  if "$SCRIPT_DIR/restore.sh" --rollback "$backup"; then
    if [ -f "$previous/storefront/server/server.mjs" ]; then
      systemctl start nota-storefront
      if ! wait_storefront "$sf_port" "$STOREFRONT_SECONDS"; then
        die "UPDATE FAILED and the backend was rolled back to $(basename "$previous"), but the old storefront does not answer. Look at: journalctl -u nota-storefront"
      fi
      die "UPDATE FAILED and was rolled back to $(basename "$previous"). The shop is running the old version again (backend and storefront)."
    fi
    # The previous release is from before the customer website: it has no storefront and its admin app is not under /admin/.
    die "UPDATE FAILED and the backend was rolled back to $(basename "$previous"). That release is older than the customer website: it has no storefront, so the website stays down and its admin app is not at /admin/ until you install a release that has them."
  fi
  die "UPDATE FAILED and the automatic rollback ALSO FAILED. The old code is linked, the services may be stopped. Backup: $backup. Restore by hand: $SCRIPT_DIR/restore.sh $backup"
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
