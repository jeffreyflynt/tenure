#!/bin/sh
set -e

INSTALL_DIR="$HOME/.tenure"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
IMAGE="tenureai/tenure:latest"
MONGO_IMAGE="mongodb/mongodb-atlas-local:8"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' 

error() {
  printf "${RED}Error: %s${NC}\n" "$1" >&2
}

warn() {
  printf "${YELLOW}Warning: %s${NC}\n" "$1" >&2
}

info() {
  printf "${GREEN}%s${NC}\n" "$1"
}

cleanup() {
  exit_code=$?
  if [ $exit_code -ne 0 ]; then
    echo ""
    error "Installation failed (exit code $exit_code)."
    echo ""
    echo "Troubleshooting:"
    echo "  - Is Docker running? Try: docker info"
    echo "  - Is port 5757 available? Try: lsof -i :5757"
    echo "  - Check logs: docker compose -f $COMPOSE_FILE logs"
    echo ""
    echo "To retry: curl -fsSL https://your-domain/install.sh | sh"
  fi
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  error "Docker is required but not installed."
  echo "  Install it from: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  error "Docker is installed but the daemon is not running."
  echo "  Start Docker Desktop or run: sudo systemctl start docker"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  error "Docker Compose (v2) is required but not found."
  echo "  Install it from: https://docs.docker.com/compose/install/"
  exit 1
fi

TENURE_PORT="${TENURE_PORT:-5757}"
if command -v lsof >/dev/null 2>&1; then
  if lsof -i :"$TENURE_PORT" >/dev/null 2>&1; then
    error "Port $TENURE_PORT is already in use."
    echo "  Either free the port or set a custom port:"
    echo "  TENURE_PORT=5858 sh install.sh"
    exit 1
  fi
elif command -v ss >/dev/null 2>&1; then
  if ss -tln | grep -q ":$TENURE_PORT "; then
    error "Port $TENURE_PORT is already in use."
    echo "  Either free the port or set a custom port:"
    echo "  TENURE_PORT=5858 sh install.sh"
    exit 1
  fi
fi

if [ -f "$COMPOSE_FILE" ]; then
  warn "Existing installation found at $INSTALL_DIR"
  printf "  Overwrite and reinstall? [y/N] "
  read -r reply
  case "$reply" in
    [Yy]*) 
      info "Stopping existing containers..."
      docker compose -f "$COMPOSE_FILE" down 2>/dev/null || true
      ;;
    *)
      echo "Aborted."
      exit 0
      ;;
  esac
fi

info "Installing Tenure..."

mkdir -p "$INSTALL_DIR"

MONGO_USER="tenure"
MONGO_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"

ENV_FILE="$INSTALL_DIR/.env"
cat > "$ENV_FILE" <<EOF
MONGO_INITDB_ROOT_USERNAME=$MONGO_USER
MONGO_INITDB_ROOT_PASSWORD=$MONGO_PASS
EOF
chmod 600 "$ENV_FILE"

cat > "$COMPOSE_FILE" <<EOF
services:
  mongo:
    image: $MONGO_IMAGE
    restart: unless-stopped
    environment:
      MONGODB_INITDB_ROOT_USERNAME: \${MONGO_INITDB_ROOT_USERNAME}
      MONGODB_INITDB_ROOT_PASSWORD: \${MONGO_INITDB_ROOT_PASSWORD}
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - internal
    volumes:
      - mongo_data:/data/db

  proxy:
    image: $IMAGE
    restart: unless-stopped
    ports:
      - "127.0.0.1:\${TENURE_PORT:-5757}:5757"
    volumes:
      - ${INSTALL_DIR}/config:/app/config
      - ${INSTALL_DIR}:/app/.tenure
    environment:
      CONFIG_PATH: /app/config/bootstrap.toml
      MONGODB_URI: mongodb://\${MONGO_INITDB_ROOT_USERNAME}:\${MONGO_INITDB_ROOT_PASSWORD}@mongo:27017/?directConnection=true&authSource=admin
    depends_on:
      mongo:
        condition: service_healthy
    networks:
      - internal
      - external

networks:
  internal:
    internal: true
  external:

volumes:
  mongo_data:
EOF

info "Pulling latest image..."
if ! docker pull "$IMAGE"; then
  error "Failed to pull image: $IMAGE"
  echo "  Check your internet connection and that the image name is correct."
  exit 1
fi

info "Starting Tenure..."
if ! docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d; then
  error "Failed to start containers."
  echo "  Check logs with: docker compose -f $COMPOSE_FILE logs"
  exit 1
fi

info "Waiting for Tenure to be ready..."
ATTEMPTS=0
MAX_ATTEMPTS=30
while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
  if curl -sf "http://localhost:${TENURE_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  ATTEMPTS=$((ATTEMPTS + 1))
  sleep 2
done

if [ $ATTEMPTS -eq $MAX_ATTEMPTS ]; then
  warn "Tenure started but did not become healthy within 60 seconds."
  echo "  Check logs: docker compose -f $COMPOSE_FILE logs proxy"
  echo "  It may still be initializing. Try opening http://localhost:${TENURE_PORT} in a moment."
else
  info "Tenure is ready!"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Tenure is running at http://localhost:${TENURE_PORT}"
echo ""
echo "  Your API token:"
docker compose -f "$COMPOSE_FILE" logs proxy 2>/dev/null | grep -i "API token:" | tail -1 | sed 's/^/  /'
echo ""
echo "  Open http://localhost:${TENURE_PORT}/onboarding to get started."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""