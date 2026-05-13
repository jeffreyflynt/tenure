#!/bin/sh
set -e

chown -R tenure:tenure /app/.tenure
exec gosu tenure "$@"