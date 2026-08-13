# JobTrail — production image
#
# WHY A DOCKERFILE AND NOT FLY'S AUTO-DETECTION
#
# libsql is a native module: it compiles C++ against the exact Node
# version and libc of the machine it is installed on. The node_modules folder on
# a Windows laptop is not portable to a Linux container — it will either fail to
# load or crash at the first query. Building inside the image is what guarantees
# the binary matches the runtime, rather than hoping.
#
# The build is two stages so the C++ toolchain (python3, make, g++ — a few
# hundred MB) is thrown away after it has done its job, and only the compiled
# .node file travels into the final image.

# ---------- stage 1: compile ----------
FROM node:22-slim AS build

# node-gyp needs these to compile libsql. They exist only in this stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copied before the source: Docker caches this layer, so editing a .js file
# doesn't trigger a five-minute recompile of SQLite.
COPY package*.json ./

# --omit=dev: Playwright is a dev dependency for tools/sniff.js and has no place
# in a production image (it would pull a whole browser).
RUN npm ci --omit=dev

# ---------- stage 2: run ----------
FROM node:22-slim

# The system's list of trusted certificate authorities.
#
# It is easy to assume this is already there — it is in the full node image, and
# the toolchain stage above installs it. But that stage is thrown away, and
# `slim` ships without it. Nothing notices until the app makes its first
# outbound TLS connection.
#
# That connection is the database. libsql reaches Turso over HTTPS and verifies
# the certificate against this store; with an empty store it cannot confirm the
# server is who it claims to be, and refuses rather than trusting blindly:
#
#   InvalidTlsConfiguration: no valid native root CA certificates found
#
# The same store is what lets the adapters fetch career pages over HTTPS, so
# omitting it breaks scraping too — just later, and less obviously.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY server ./server
COPY client ./client
COPY tools ./tools

# JT_DB_PATH is deliberately NOT set here.
#
# Where the database lives is a property of the deployment, not of the image:
# on a host with a persistent volume it belongs on the volume (fly.toml), and on
# a free host with no disk it is the seeded copy inside the image
# (render.yaml). Baking one of those choices in would make the other silently
# write to a filesystem that is erased on the next restart — which looks exactly
# like working, right up until the data is gone.
ENV HOST=0.0.0.0
ENV PORT=8080

# Fly terminates TLS at its edge and forwards plain HTTP inside the network, so
# Node never sees a certificate. This flag is what tells the session cookie to
# mark itself Secure anyway — without it the cookie is sent over the public
# internet unprotected, and nothing in the logs would say so.
ENV JT_BEHIND_HTTPS=1

# Not root. If a bug ever lets someone write a file, it should not be able to
# write to the system.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080

CMD ["node", "server/web/server.js"]
