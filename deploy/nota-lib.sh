#!/usr/bin/env bash
# Shared helpers for the Nota server scripts. Sourced, never run directly.
# shellcheck shell=bash

NOTA_ETC="${NOTA_ETC:-/etc/nota}"
NOTA_BACKEND_ENV="${NOTA_BACKEND_ENV:-$NOTA_ETC/backend.env}"
NOTA_BACKUP_ENV="${NOTA_BACKUP_ENV:-$NOTA_ETC/backup.env}"
NOTA_ROOT="${NOTA_ROOT:-/opt/nota}"
NOTA_BACKUP_DIR="${NOTA_BACKUP_DIR:-/var/backups/nota}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

require_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }

# env_get KEY FILE: value of KEY in a KEY=VALUE file (surrounding quotes removed). Never sources the file,
# so values with & ? or spaces are safe. Prints nothing when missing.
env_get() {
  local key="$1" file="$2" line
  [ -f "$file" ] || return 0
  line="$(grep -m1 "^${key}=" "$file" || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  printf '%s' "$line"
}

# env_set KEY VALUE FILE: replace the line of KEY or append it. Keeps owner and mode of an existing file.
env_set() {
  local key="$1" value="$2" file="$3" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  if [ -f "$file" ]; then
    chmod --reference="$file" "$tmp"
    chown --reference="$file" "$tmp"
    { grep -v "^${key}=" "$file" || true; printf '%s=%s\n' "$key" "$value"; } >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv -f "$tmp" "$file"
}

# wait_health PORT SECONDS: 0 when GET /health answers {"ok":true...} within SECONDS.
wait_health() {
  local port="$1" seconds="$2" waited=0 body
  while [ "$waited" -lt "$seconds" ]; do
    body="$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
    case "$body" in *'"ok":true'*) return 0 ;; esac
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# Online Stage 5B: the storefront (server-side rendered customer website) is its own service next to the backend.
NOTA_STOREFRONT_ENV="${NOTA_STOREFRONT_ENV:-$NOTA_ETC/storefront.env}"

storefront_port() {
  local port
  port="$(env_get NOTA_STOREFRONT_PORT "$NOTA_STOREFRONT_ENV")"
  printf '%s' "${port:-4000}"
}

# storefront_up PORT: 0 when the storefront's own /health answers AND GET / is either 200 or the closed page
# (503 with X-Nota-Closed: 1, which is what a switched-off website looks like). A 503 without that header means the
# storefront cannot reach the backend, which is a failure.
storefront_up() {
  local port="$1" body headers status
  body="$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
  case "$body" in *'"ok":true'*) ;; *) return 1 ;; esac
  headers="$(curl -sS --max-time 10 -o /dev/null -D - "http://127.0.0.1:${port}/" 2>/dev/null || true)"
  status="$(printf '%s' "$headers" | head -n 1 | tr -d '\r' | awk '{print $2}')"
  [ "$status" = "200" ] && return 0
  if [ "$status" = "503" ] && printf '%s' "$headers" | grep -qi '^x-nota-closed: *1'; then return 0; fi
  return 1
}

# wait_storefront PORT SECONDS: 0 when storefront_up succeeds within SECONDS.
wait_storefront() {
  local port="$1" seconds="$2" waited=0
  while [ "$waited" -lt "$seconds" ]; do
    storefront_up "$port" && return 0
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# ensure_vapid: Online Stage 6A. Web Push needs a VAPID key pair on the server. Generated once, only when missing
# (never replaces an existing pair: a new pair would orphan every phone's subscription). Used by setup-server.sh (a new server has
# push from the start) and update.sh (an older server gets it on its first update): the same code path. It needs only Node's own
# crypto (the same P-256 pair, base64url, that web-push's generateVAPIDKeys makes), so it works before any release is installed.
# The keys live only in the backend env file, never in the repo or the release.
ensure_vapid() {
  local keys subject
  if [ -z "$(env_get NOTA_VAPID_PUBLIC_KEY "$NOTA_BACKEND_ENV")" ] || [ -z "$(env_get NOTA_VAPID_PRIVATE_KEY "$NOTA_BACKEND_ENV")" ]; then
    keys="$(node -e "const c=require('node:crypto');const k=c.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'jwk'});const b=(s)=>Buffer.from(s,'base64url');process.stdout.write(Buffer.concat([Buffer.from([4]),b(k.x),b(k.y)]).toString('base64url')+' '+k.d)" 2>/dev/null || true)"
    case "$keys" in
      *" "*)
        env_set NOTA_VAPID_PUBLIC_KEY "${keys%% *}" "$NOTA_BACKEND_ENV"
        env_set NOTA_VAPID_PRIVATE_KEY "${keys#* }" "$NOTA_BACKEND_ENV"
        log "VAPID keys generated (phone notifications)"
        ;;
      *) log "WARNING: could not generate VAPID keys; phone notifications stay off until the next update" ;;
    esac
  fi
  if [ -z "$(env_get NOTA_VAPID_SUBJECT "$NOTA_BACKEND_ENV")" ]; then
    subject="$(shop_domain)"
    [ -n "$subject" ] && env_set NOTA_VAPID_SUBJECT "https://$subject" "$NOTA_BACKEND_ENV"
  fi
  return 0
}

# ensure_secrets_key: Online Stage 7B. NOTA_SECRETS_KEY (64 hex chars = 32 random bytes) encrypts the secrets Nota stores for the
# shop (the Meta ad account token). Generated once, only when missing: replacing it would make every stored token unreadable (the
# owner would have to reconnect). It lives only in the backend env file. backup.sh does not save that file, so copy it with your backup.
ensure_secrets_key() {
  local key
  if [ -z "$(env_get NOTA_SECRETS_KEY "$NOTA_BACKEND_ENV")" ]; then
    key="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" 2>/dev/null || true)"
    case "$key" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) env_set NOTA_SECRETS_KEY "$key" "$NOTA_BACKEND_ENV"; log "NOTA_SECRETS_KEY generated" ;;
      *) log "WARNING: could not generate NOTA_SECRETS_KEY; connecting the ad account stays off until the next update" ;;
    esac
  fi
  return 0
}

backend_port() {
  local port
  port="$(env_get PORT "$NOTA_BACKEND_ENV")"
  printf '%s' "${port:-5000}"
}

# shop_domain: the domain, taken from CORS_ORIGINS=https://<domain>.
shop_domain() {
  local origin
  origin="$(env_get CORS_ORIGINS "$NOTA_BACKEND_ENV")"
  origin="${origin#https://}"
  printf '%s' "${origin%%,*}"
}
