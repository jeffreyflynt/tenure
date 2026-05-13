FROM node:25-bookworm-slim AS crypt
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

ARG MONGO_CRYPT_VERSION=8.2.6
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
      URL="https://downloads.mongodb.com/linux/mongo_crypt_shared_v1-linux-aarch64-enterprise-ubuntu2204-${MONGO_CRYPT_VERSION}.tgz"; \
    else \
      URL="https://downloads.mongodb.com/linux/mongo_crypt_shared_v1-linux-x86_64-enterprise-debian12-${MONGO_CRYPT_VERSION}.tgz"; \
    fi && \
    mkdir -p /tmp/crypt /tmp/lib && \
    curl -fsSL --max-time 120 "$URL" | tar -xz -C /tmp/crypt --strip-components=1 && \
    find /tmp/crypt -name "mongo_crypt_v1.so" -exec cp {} /tmp/lib/mongo_crypt_v1.so \;

FROM node:25-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:25-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:25-bookworm-slim AS runtime
WORKDIR /app

RUN groupadd --system tenure && useradd --system --gid tenure --no-create-home --shell /usr/sbin/nologin tenure

COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=crypt /tmp/lib/mongo_crypt_v1.so /app/vendor/mongo_crypt_v1.so

RUN mkdir -p /app/config /app/.tenure && \
    chown -R tenure:tenure /app

RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production

EXPOSE 5757

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]