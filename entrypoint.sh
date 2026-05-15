#!/bin/sh
set -e

TENURE_HOME="${TENURE_HOME:-/app/.tenure}"

chown -R tenure:tenure "$TENURE_HOME"

if [ "$1" = "init" ]; then

  mkdir -p "$TENURE_HOME/config"

  if [ ! -f "$TENURE_HOME/docker-compose.yml" ]; then
    cp /app/docker-compose.yml "$TENURE_HOME/docker-compose.yml"
    echo "compose file written"
  else
    echo "compose file already present, skipping"
  fi

  if [ ! -f "$TENURE_HOME/.env" ]; then
    MONGO_PASS=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64').replace(/[\/+=]/g,'').slice(0,32))")
    printf 'MONGO_INITDB_ROOT_USERNAME=tenure\nMONGO_INITDB_ROOT_PASSWORD=%s\nTENURE_PORT=5757\n' \
      "$MONGO_PASS" > "$TENURE_HOME/.env"
    chmod 600 "$TENURE_HOME/.env"
    echo "credentials written"
  else
    echo "credentials already present, skipping"
  fi

  exit 0
fi

exec gosu tenure "$@"