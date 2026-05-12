#!/bin/sh
set -e

INSTALL_DIR="$HOME/.tenure"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
ENV_FILE="$INSTALL_DIR/.env"

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

if [ ! -f "$ENV_FILE" ]; then
  error "Credentials file not found at $ENV_FILE"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  error "Docker is not running."
  echo "  Start Docker Desktop or run: sudo systemctl start docker"
  exit 1
fi

# Check containers are up
MONGO_RUNNING=$(docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -c "mongo" || true)
if [ "$MONGO_RUNNING" -eq 0 ]; then
  error "Tenure is not running. Start it first:"
  echo "  docker compose -f $COMPOSE_FILE up -d"
  exit 1
fi

echo ""
warn "This will rotate the internal MongoDB credentials."
echo "  Tenure will be briefly unavailable during the restart."
echo ""
printf "  Proceed? [y/N] "
read -r reply
case "$reply" in
  [Yy]*) ;;
  *) echo "Aborted."; exit 0 ;;
esac

echo ""

NEW_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32 2>/dev/null \
  || head -c 32 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 32)"

info "Rotating credentials in MongoDB..."
if ! docker compose -f "$COMPOSE_FILE" exec mongo mongosh \
  --quiet \
  --eval "db.getSiblingDB('admin').changeUserPassword('tenure', '$NEW_PASS')"; then
  error "Failed to rotate credentials in MongoDB."
  echo "  Your credentials have not been changed. Check container logs:"
  echo "  docker compose -f $COMPOSE_FILE logs mongo"
  exit 1
fi

info "Updating credentials file..."
# Use a temp file to avoid sed -i portability issues between Linux and macOS
TMPFILE="$(mktemp)"
sed "s/^MONGO_INITDB_ROOT_PASSWORD=.*/MONGO_INITDB_ROOT_PASSWORD=$NEW_PASS/" "$ENV_FILE" > "$TMPFILE"
mv "$TMPFILE" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Restart proxy so it picks up the new MONGODB_URI from .env
info "Restarting proxy..."
if ! docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d proxy; then
  error "Proxy restart failed. Tenure may be unavailable."
  echo "  Try restarting manually:"
  echo "  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d"
  exit 1
fi

echo ""
info "Credentials rotated successfully."
echo ""