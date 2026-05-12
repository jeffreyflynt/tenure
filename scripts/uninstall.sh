#!/bin/sh
set -e

INSTALL_DIR="$HOME/.tenure"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

error() { printf "${RED}Error: %s${NC}\n" "$1" >&2; }
warn()  { printf "${YELLOW}Warning: %s${NC}\n" "$1" >&2; }
info()  { printf "${GREEN}%s${NC}\n" "$1"; }

if [ ! -f "$COMPOSE_FILE" ]; then
  error "No Tenure installation found at $INSTALL_DIR"
  exit 1
fi

echo ""
warn "This will permanently delete Tenure and all of your belief data."
echo ""
echo "  This includes:"
echo "    - All beliefs, sessions, and compaction history"
echo "    - Your provider credentials"
echo "    - All configuration"
echo ""
echo "  If you have not exported a backup, your world model cannot be recovered."
echo "  Export first at: http://localhost:5757/admin/backup"
echo ""
printf "  Type 'yes' to confirm uninstall: "
read -r reply

if [ "$reply" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

echo ""
info "Stopping containers and removing volumes..."
docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true

info "Removing $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"

echo ""
info "Tenure has been uninstalled."
echo ""