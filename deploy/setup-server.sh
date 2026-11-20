#!/usr/bin/env bash
# Nota: one-time server setup. Run as root on a fresh Ubuntu 24.04 VPS, from the uploaded deploy/ folder:
#   bash setup-server.sh <domain> <admin-email>
# Safe to run again: every step checks what already exists, and generated secrets are never replaced.
# Not automated on purpose: SSH key login / disabling password login (see docs/deploy/NEW_SERVER_AR.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/nota-lib.sh"

require_root

domain="${1:-}"
email="${2:-}"
[ -n "$domain" ] && [ -n "$email" ] || die "usage: bash setup-server.sh <domain> <admin-email>"
[[ "$domain" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "bad domain (lower case, e.g. shop.example.com): $domain"
[[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "bad email: $email"

PORT=5000
STOREFRONT_PORT=4000
DB_NAME=nota
MONGO_ADMIN_FILE="$NOTA_ETC/mongo-admin.env"
KEYFILE=/etc/mongodb-keyfile
CERT_DIR="/etc/letsencrypt/live/$domain"
export DEBIAN_FRONTEND=noninteractive
# Ubuntu 24.04 needrestart would ask which services to restart during apt: "a" = restart automatically, never ask.
export NEEDRESTART_MODE=a
# Never stop at a conffile prompt either: keep the existing config file, take the default for new ones.
APT_OPTS=(-y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold")

# A nota nginx site left from an earlier run must not point at a certificate that is gone: apt may restart nginx below.
# (It is rebuilt in step 9, HTTP-only first.)
if [ ! -s "$CERT_DIR/fullchain.pem" ] && [ -L /etc/nginx/sites-enabled/nota ]; then
  rm -f /etc/nginx/sites-enabled/nota
fi

[ -r /etc/os-release ] || die "cannot read /etc/os-release"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] && [ "${VERSION_ID:-}" = "24.04" ] || die "this script is for Ubuntu 24.04 (found ${PRETTY_NAME:-unknown})"

for f in nota-lib.sh backup.sh restore.sh update.sh nota-owner.sh \
  templates/nota-backend.service templates/nota-storefront.service templates/nota-backup.service templates/nota-backup.timer \
  templates/nota-meta-sync.service templates/nota-meta-sync.timer nota-meta-sync.sh \
  templates/nginx-nota.conf.template templates/nginx-nota-http.conf.template \
  templates/nginx-security-headers.conf templates/nginx-proxy-api.conf templates/nginx-proxy-storefront.conf templates/nginx-ratelimit.conf \
  templates/backup.env.example; do
  [ -f "$SCRIPT_DIR/$f" ] || die "missing $SCRIPT_DIR/$f: upload the whole deploy/ folder"
done

rand_hex() { openssl rand -hex "$1"; }

# --- 1. packages ------------------------------------------------------------------------------------------------
log "setup: apt update/upgrade and base packages"
apt-get update -y
apt-get "${APT_OPTS[@]}" upgrade
apt-get "${APT_OPTS[@]}" install curl gnupg ca-certificates openssl unzip nginx certbot ufw fail2ban unattended-upgrades

# rclone from the official installer (the Ubuntu package is old). Skipped when already installed; update later with
# the same command: curl https://rclone.org/install.sh | bash
if ! command -v rclone >/dev/null 2>&1; then
  log "setup: installing rclone (official installer from rclone.org)"
  rclone_installer="$(mktemp)"
  curl -fsSL https://rclone.org/install.sh -o "$rclone_installer"
  bash "$rclone_installer"
  rm -f "$rclone_installer"
fi
command -v rclone >/dev/null 2>&1 || die "rclone is not installed"

log "setup: time zone Africa/Cairo"
timedatectl set-timezone Africa/Cairo

# --- 2. DNS must point here before anything that needs the certificate -------------------------------------------
server_ip="$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)"
dns_ip="$(getent ahostsv4 "$domain" | awk 'NR==1{print $1}' || true)"
if [ -z "$dns_ip" ] || { [ -n "$server_ip" ] && [ "$dns_ip" != "$server_ip" ]; }; then
  log "STOP: $domain does not point to this server (DNS: ${dns_ip:-none}, this server: ${server_ip:-unknown})."
  log "Add an A record  $domain -> ${server_ip:-<server IP>}  at your DNS provider, wait a few minutes, then run this script again."
  log "أضف سجل A للدومين $domain يشير إلى ${server_ip:-<server IP>} ثم أعد تشغيل السكربت."
  exit 1
fi

# --- 3. Node 24 and MongoDB 8 from their official repositories ---------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]; then
  log "setup: installing Node 24 (NodeSource)"
  install -d -m 755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get "${APT_OPTS[@]}" install nodejs
fi

if ! command -v mongod >/dev/null 2>&1; then
  log "setup: installing MongoDB 8"
  curl -fsSL https://pgp.mongodb.com/server-8.0.asc | gpg --dearmor --yes -o /usr/share/keyrings/mongodb-server-8.0.gpg
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" >/etc/apt/sources.list.d/mongodb-org-8.0.list
  apt-get update -y
  apt-get "${APT_OPTS[@]}" install mongodb-org
fi

log "setup: unattended security upgrades"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# --- 4. user and folders ------------------------------------------------------------------------------------------
if ! id nota >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/nota --create-home --shell /usr/sbin/nologin nota
fi
install -d -m 755 "$NOTA_ROOT" "$NOTA_ROOT/releases" "$NOTA_ROOT/bin"
install -d -o root -g nota -m 750 "$NOTA_ETC"
install -d -o root -g root -m 700 "$NOTA_BACKUP_DIR"

log "setup: installing scripts into $NOTA_ROOT/bin"
for f in nota-lib.sh backup.sh restore.sh update.sh nota-owner.sh nota-meta-sync.sh; do
  install -o root -g root -m 755 "$SCRIPT_DIR/$f" "$NOTA_ROOT/bin/$f"
done
ln -sfn "$NOTA_ROOT/bin/nota-owner.sh" /usr/local/bin/nota-owner
ln -sfn "$NOTA_ROOT/bin/nota-meta-sync.sh" /usr/local/bin/nota-meta-sync

# --- 5. generated secrets (only when missing) -------------------------------------------------------------------
umask 077
if [ ! -f "$MONGO_ADMIN_FILE" ]; then
  printf 'MONGO_ADMIN_USER=nota_admin\nMONGO_ADMIN_PASSWORD=%s\n' "$(rand_hex 24)" >"$MONGO_ADMIN_FILE"
fi
chown root:root "$MONGO_ADMIN_FILE"
chmod 600 "$MONGO_ADMIN_FILE"

if [ -z "$(env_get NOTA_MONGO_APP_PASSWORD "$MONGO_ADMIN_FILE")" ]; then
  env_set NOTA_MONGO_APP_PASSWORD "$(rand_hex 24)" "$MONGO_ADMIN_FILE"
fi
admin_user="$(env_get MONGO_ADMIN_USER "$MONGO_ADMIN_FILE")"
admin_pass="$(env_get MONGO_ADMIN_PASSWORD "$MONGO_ADMIN_FILE")"
app_pass="$(env_get NOTA_MONGO_APP_PASSWORD "$MONGO_ADMIN_FILE")"
umask 022

if [ ! -f "$KEYFILE" ]; then
  (umask 077 && openssl rand -base64 756 >"$KEYFILE")
fi
chown mongodb:mongodb "$KEYFILE"
chmod 400 "$KEYFILE"

# --- 6. MongoDB: 127.0.0.1 only, replica set rs0, authorization on ----------------------------------------------
write_mongod_conf() { # $1 = "auth" or "open"
  cat >/etc/mongod.conf <<EOF
storage:
  dbPath: /var/lib/mongodb
systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log
net:
  port: 27017
  bindIp: 127.0.0.1
processManagement:
  timeZoneInfo: /usr/share/zoneinfo
replication:
  replSetName: rs0
EOF
  if [ "$1" = "auth" ]; then
    cat >>/etc/mongod.conf <<EOF
security:
  authorization: enabled
  keyFile: $KEYFILE
EOF
  fi
}

# mongosh_run JS: runs JS against 127.0.0.1 without credentials. Passwords are passed through the environment only.
mongosh_run() { mongosh --quiet --host 127.0.0.1 --port 27017 --eval "$1"; }
# mongosh_admin JS: same, signed in as the admin user first.
mongosh_admin() {
  MONGO_USER="$admin_user" MONGO_PASS="$admin_pass" mongosh --quiet --host 127.0.0.1 --port 27017 \
    --eval "db.getSiblingDB('admin').auth(process.env.MONGO_USER, process.env.MONGO_PASS); $1"
}

wait_for() { # wait_for SECONDS DESCRIPTION CMD...
  local seconds="$1" what="$2" waited=0
  shift 2
  until "$@" >/dev/null 2>&1; do
    sleep 2
    waited=$((waited + 2))
    [ "$waited" -lt "$seconds" ] || die "timed out waiting for $what"
  done
}

if grep -q 'authorization: enabled' /etc/mongod.conf 2>/dev/null; then
  log "setup: MongoDB already configured with authorization"
  systemctl enable --now mongod
else
  log "setup: configuring MongoDB (first run: replica set, users, then authorization)"
  write_mongod_conf open
  systemctl enable mongod
  systemctl restart mongod
  wait_for 90 "mongod to answer" mongosh_run "db.runCommand({ping:1}).ok"
  mongosh_run "try { rs.status().ok } catch (e) { rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]}).ok }" >/dev/null
  wait_for 90 "the replica set to become PRIMARY" mongosh_run "if (!db.hello().isWritablePrimary) { throw new Error('not primary') }"

  MONGO_USER="$admin_user" MONGO_PASS="$admin_pass" APP_PASS="$app_pass" mongosh --quiet --host 127.0.0.1 --port 27017 --eval "
    const admin = db.getSiblingDB('admin');
    if (admin.getUser(process.env.MONGO_USER)) { admin.changeUserPassword(process.env.MONGO_USER, process.env.MONGO_PASS); }
    else { admin.createUser({user: process.env.MONGO_USER, pwd: process.env.MONGO_PASS, roles: [{role: 'root', db: 'admin'}]}); }
    const app = db.getSiblingDB('$DB_NAME');
    if (app.getUser('nota_app')) { app.changeUserPassword('nota_app', process.env.APP_PASS); }
    else { app.createUser({user: 'nota_app', pwd: process.env.APP_PASS, roles: [{role: 'readWrite', db: '$DB_NAME'}]}); }
  " >/dev/null

  write_mongod_conf auth
  systemctl restart mongod
fi
wait_for 90 "mongod with authorization" mongosh_admin "if (!db.hello().isWritablePrimary) { throw new Error('not primary') }"
log "setup: MongoDB is PRIMARY of rs0, authorization on, listening on 127.0.0.1 only"

# --- 7. backend environment ----------------------------------------------------------------------------------------
umask 077
touch "$NOTA_BACKEND_ENV"
chown root:nota "$NOTA_BACKEND_ENV"
chmod 640 "$NOTA_BACKEND_ENV"
umask 022
env_set NODE_ENV production "$NOTA_BACKEND_ENV"
env_set NOTA_LISTEN_HOST 127.0.0.1 "$NOTA_BACKEND_ENV"
env_set NOTA_TRUST_PROXY 1 "$NOTA_BACKEND_ENV"
env_set CORS_ORIGINS "https://$domain" "$NOTA_BACKEND_ENV"
[ -n "$(env_get PORT "$NOTA_BACKEND_ENV")" ] || env_set PORT "$PORT" "$NOTA_BACKEND_ENV"
env_set MONGO_URI "mongodb://nota_app:${app_pass}@127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&authSource=${DB_NAME}" "$NOTA_BACKEND_ENV"
[ -n "$(env_get NOTA_JWT_SECRET "$NOTA_BACKEND_ENV")" ] || env_set NOTA_JWT_SECRET "$(rand_hex 48)" "$NOTA_BACKEND_ENV"
# Online Stage 3: the customer website signs its own tokens with a separate secret (only generated when missing).
[ -n "$(env_get NOTA_STORE_JWT_SECRET "$NOTA_BACKEND_ENV")" ] || env_set NOTA_STORE_JWT_SECRET "$(rand_hex 48)" "$NOTA_BACKEND_ENV"
# Online Stage 6A: the VAPID key pair for phone notifications (only generated when missing; same function update.sh uses).
ensure_vapid
# Online Stage 7B: the key that encrypts the stored Meta token (only generated when missing).
ensure_secrets_key
PORT="$(backend_port)"

# Online Stage 5B: the storefront's environment. It calls the backend on loopback and never needs a secret. Existing values
# (e.g. a changed port) are kept; the public URL and the allowed host follow the domain given to this script.
umask 077
touch "$NOTA_STOREFRONT_ENV"
chown root:nota "$NOTA_STOREFRONT_ENV"
chmod 640 "$NOTA_STOREFRONT_ENV"
umask 022
env_set NODE_ENV production "$NOTA_STOREFRONT_ENV"
[ -n "$(env_get NOTA_STOREFRONT_PORT "$NOTA_STOREFRONT_ENV")" ] || env_set NOTA_STOREFRONT_PORT "$STOREFRONT_PORT" "$NOTA_STOREFRONT_ENV"
env_set NOTA_API_INTERNAL "http://127.0.0.1:$PORT" "$NOTA_STOREFRONT_ENV"
env_set NOTA_PUBLIC_URL "https://$domain" "$NOTA_STOREFRONT_ENV"
STOREFRONT_PORT="$(storefront_port)"

if [ ! -f "$NOTA_BACKUP_ENV" ]; then
  install -o root -g root -m 600 "$SCRIPT_DIR/templates/backup.env.example" "$NOTA_BACKUP_ENV"
fi

# --- 8. systemd ------------------------------------------------------------------------------------------------------
log "setup: systemd units"
install -m 644 "$SCRIPT_DIR/templates/nota-backend.service" /etc/systemd/system/nota-backend.service
install -m 644 "$SCRIPT_DIR/templates/nota-storefront.service" /etc/systemd/system/nota-storefront.service
install -m 644 "$SCRIPT_DIR/templates/nota-backup.service" /etc/systemd/system/nota-backup.service
install -m 644 "$SCRIPT_DIR/templates/nota-backup.timer" /etc/systemd/system/nota-backup.timer
# Online Stage 7B: the daily Meta ad account sync (does nothing until the owner connects the account in the app).
install -m 644 "$SCRIPT_DIR/templates/nota-meta-sync.service" /etc/systemd/system/nota-meta-sync.service
install -m 644 "$SCRIPT_DIR/templates/nota-meta-sync.timer" /etc/systemd/system/nota-meta-sync.timer
systemctl daemon-reload
# The backend and the storefront are enabled now but started by the first update.sh (there is no release yet).
systemctl enable nota-backend nota-storefront
systemctl enable --now nota-backup.timer
systemctl enable --now nota-meta-sync.timer

# --- 9. nginx and HTTPS ----------------------------------------------------------------------------------------------
# Sequence (nginx is never given a config that points at certificate files that do not exist):
#   a) no certificate yet: install the HTTP-only site (port 80, ACME challenge path, no ssl), test and reload nginx
#   b) check that nginx really serves the challenge path, then certbot (webroot) obtains the certificate
#   c) only when the certificate files exist: install the HTTPS site, test, reload
# Re-run with a certificate already in place: (a) and (b) are skipped, (c) simply re-applies the site.
log "setup: nginx"
install -d -m 755 /var/www/html /etc/nginx/snippets /etc/nginx/conf.d
install -m 644 "$SCRIPT_DIR/templates/nginx-security-headers.conf" /etc/nginx/snippets/nota-security-headers.conf
install -m 644 "$SCRIPT_DIR/templates/nginx-proxy-api.conf" /etc/nginx/snippets/nota-proxy-api.conf
install -m 644 "$SCRIPT_DIR/templates/nginx-proxy-storefront.conf" /etc/nginx/snippets/nota-proxy-storefront.conf
install -m 644 "$SCRIPT_DIR/templates/nginx-ratelimit.conf" /etc/nginx/conf.d/nota-ratelimit.conf
rm -f /etc/nginx/sites-enabled/default
render() { sed -e "s/@@DOMAIN@@/$domain/g" -e "s/@@PORT@@/$PORT/g" -e "s/@@STOREFRONT_PORT@@/$STOREFRONT_PORT/g" "$1"; }
cert_ready() { [ -s "$CERT_DIR/fullchain.pem" ] && [ -s "$CERT_DIR/privkey.pem" ]; }

# apply_site TEMPLATE: install it as the nota site, `nginx -t`, reload. On a failed test the previous site is put back.
apply_site() {
  local site=/etc/nginx/sites-available/nota backup="" rendered
  rendered="$(mktemp)"
  render "$1" >"$rendered"
  if [ -f "$site" ]; then
    backup="$(mktemp)"
    cp "$site" "$backup"
  fi
  install -m 644 "$rendered" "$site"
  rm -f "$rendered"
  ln -sfn "$site" /etc/nginx/sites-enabled/nota
  if ! nginx -t; then
    if [ -n "$backup" ]; then
      cp "$backup" "$site"
    else
      rm -f /etc/nginx/sites-enabled/nota "$site"
    fi
    rm -f "$backup"
    die "nginx config test failed for $(basename "$1"); the previous nginx site was put back"
  fi
  rm -f "$backup"
  systemctl enable nginx
  systemctl reload nginx || systemctl restart nginx
}

if ! cert_ready; then
  apply_site "$SCRIPT_DIR/templates/nginx-nota-http.conf.template"

  token="nota-check-$(rand_hex 8)"
  install -d -m 755 /var/www/html/.well-known/acme-challenge
  printf 'ok' >"/var/www/html/.well-known/acme-challenge/$token"
  served="$(curl -fsS --max-time 10 --resolve "$domain:80:127.0.0.1" "http://$domain/.well-known/acme-challenge/$token" || true)"
  rm -f "/var/www/html/.well-known/acme-challenge/$token"
  [ "$served" = "ok" ] || die "nginx does not serve /.well-known/acme-challenge/ for $domain: certbot would fail (see 'nginx -T')"

  log "setup: requesting the HTTPS certificate for $domain"
  certbot certonly --webroot -w /var/www/html -d "$domain" -m "$email" --agree-tos --no-eff-email --non-interactive \
    --deploy-hook "systemctl reload nginx"
fi

cert_ready || die "no certificate for $domain in $CERT_DIR: the HTTPS site was NOT installed (nginx keeps the HTTP-only site)"
apply_site "$SCRIPT_DIR/templates/nginx-nota.conf.template"

systemctl enable --now certbot.timer
systemctl is-active --quiet certbot.timer || die "certbot.timer is not active: automatic renewal would not run"
certbot renew --dry-run >/dev/null || die "certbot renew --dry-run failed: fix this before relying on auto-renewal"
log "setup: certificate renewal timer is active and a dry run passed"

# --- 10. firewall and fail2ban ---------------------------------------------------------------------------------------
log "setup: firewall and fail2ban"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
cat >/etc/fail2ban/jail.d/nota-sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
bantime = 1h
EOF
systemctl enable fail2ban
systemctl restart fail2ban

# --- done ---------------------------------------------------------------------------------------------------------------
log "setup: finished. Secrets are in $NOTA_ETC (backend.env, mongo-admin.env); nothing was printed."
cat <<EOF

Next steps:
  1. On your PC build a release:  node deploy/make-release.js
  2. Upload it:  scp release\\release-<version>-<commit>.tar.gz root@$domain:/root/
  3. On the server:  $NOTA_ROOT/bin/update.sh /root/release-<version>-<commit>.tar.gz
  4. Create the owner:  nota-owner create --username <name> --name "<Full name>"
  5. Open https://$domain (the shop's website) and https://$domain/admin/ (the admin app, where you sign in)
  6. Set up SSH keys and off-server backups: docs/deploy/NEW_SERVER_AR.md and BACKUP_RESTORE_AR.md
EOF
