FROM node:25-alpine AS crypt
RUN apk add --no-cache curl

ARG MONGO_CRYPT_VERSION=8.2.6
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then ARCH_SUFFIX="aarch64"; else ARCH_SUFFIX="x86_64"; fi && \
    curl -fsSL "https://downloads.mongodb.com/linux/mongo_crypt_shared_v1-linux-${ARCH_SUFFIX}-enterprise-debian12-${MONGO_CRYPT_VERSION}.tgz" \
    | tar -xz -C /tmp --strip-components=1

FROM node:25-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts

FROM node:25-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:25-bookworm-slim AS runtime
WORKDIR /app

RUN groupadd --system tenure && useradd --system --gid tenure tenure

COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=crypt /tmp/lib/mongo_crypt_v1.so /app/vendor/mongo_crypt_v1.so

RUN mkdir -p /app/config /app/.tenure && \
    chown -R tenure:tenure /app

USER tenure

ENV NODE_ENV=production

EXPOSE 5757

CMD ["node", "dist/index.js"]