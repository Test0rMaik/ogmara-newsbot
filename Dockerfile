# syntax=docker/dockerfile:1

# ---- Build stage --------------------------------------------------------
# Compiles TypeScript. Kept separate from the runtime stage so dev
# dependencies (tsx, vitest, typescript itself) never end up in the image
# that actually runs unattended against a real wallet.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage -------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Pull in whatever patched Alpine packages exist as of build time (e.g. the
# base image's bundled libssl/libcrypto trail the upstream release by a few
# days) rather than trusting the base image tag alone to be current.
RUN apk update && apk upgrade --no-cache

# Production dependencies only — same reasoning as the build stage split.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && \
    # npm itself (and its own large, separately-versioned dependency tree —
    # tar, sigstore, picomatch, etc., bundled by the base image) is never
    # invoked at runtime: the entrypoint below runs `node dist/index.js`
    # directly, never `npm start`/`npx`. Keeping it around is pure attack
    # surface with no functional purpose in the final image — a scanner will
    # (correctly) keep flagging its CVEs even though this container can never
    # reach that code path. Remove it rather than carry a lasting exception.
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /usr/local/lib/node_modules/corepack /opt/yarn-v*

COPY --from=build /app/dist ./dist
# Prompt templates are the operator-editable default set; config.ai.promptPath
# etc. can point elsewhere via a mounted override, but the defaults must exist
# for a config that doesn't override them.
COPY prompts ./prompts
COPY config.example.yaml LICENSE ./

# data/ holds the dedup ledger and retry queue — both must survive a
# container recreate, so this exists purely as a documented mount point.
# Owned by the image's built-in non-root `node` user (uid 1000): the process
# never needs root, and a bot signing with a real wallet key is exactly the
# kind of process that shouldn't have it.
RUN mkdir -p data && chown -R node:node /app
USER node

# Only meaningful when panel.enabled: true and only documents intent — an
# operator must still publish the port explicitly (`-p` / compose `ports:`)
# for it to be reachable from outside the container.
EXPOSE 8787

ENTRYPOINT ["node", "dist/index.js"]
