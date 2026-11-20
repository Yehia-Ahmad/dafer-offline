#!/usr/bin/env bash
# Online Stage 7B: reads the shop's Meta (Facebook/Instagram) ad account into Nota. Read-only toward Meta.
# Run by the nota-meta-sync.timer every day at 06:15 (re-syncs the last 7 days). By hand (as root):
#   nota-meta-sync               re-sync the last 7 days
#   nota-meta-sync --backfill    read the last 90 days
# Nothing happens when the ad account is not connected. A Mongo lock keeps it from overlapping with the «مزامنة دلوقتي» button.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/nota-lib.sh"

require_root
[ -d "$NOTA_ROOT/current/backend" ] || { log "nota-meta-sync: no release installed yet"; exit 0; }
cd "$NOTA_ROOT/current/backend"
# dotenv/config loads the production env file (it holds the database address and NOTA_SECRETS_KEY).
exec runuser -u nota -- env "DOTENV_CONFIG_PATH=$NOTA_BACKEND_ENV" node -r dotenv/config scripts/meta-sync.js "$@"
