#!/usr/bin/env bash
# Runs the owner scripts of the current release with the production environment.
# Usage (as root):  nota-owner create --username <name> [--name "<Full name>"]
#                   nota-owner recover
# The password is asked on the terminal. The recovery code is printed once.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/nota-lib.sh"

require_root
action="${1:-}"
case "$action" in
  create) script="scripts/create-owner.js" ;;
  recover) script="scripts/recover-owner.js" ;;
  *) die "usage: nota-owner create --username <name> [--name \"<Full name>\"] | nota-owner recover" ;;
esac
shift

[ -d "$NOTA_ROOT/current/backend" ] || die "no release installed yet: run update.sh first"
cd "$NOTA_ROOT/current/backend"
# dotenv/config loads the production env file (values with & or ? are safe there).
exec runuser -u nota -- env "DOTENV_CONFIG_PATH=$NOTA_BACKEND_ENV" node -r dotenv/config "$script" "$@"
