# Build context is the repository root, not this directory. @flagship/core is a
# workspace dependency resolved through a symlink in the root node_modules, so a
# build that cannot see packages/core has nothing to link to.
#
#   docker build -f apps/control-plane/Dockerfile -t flagship-control-plane .

FROM node:22-alpine AS build
WORKDIR /app

# Manifests before sources so an edit to a .ts file does not re-run the install.
# Every workspace manifest has to be present even though only two are built:
# npm ci validates the lockfile against the whole workspace and refuses to
# proceed when a member is missing.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/sdk-js/package.json packages/sdk-js/
COPY apps/console/package.json apps/console/
COPY apps/control-plane/package.json apps/control-plane/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/control-plane ./apps/control-plane

# Ordered, not parallel: the control plane's tsconfig resolves @flagship/core to
# packages/core/dist, which does not exist until core is compiled.
RUN npm run build --workspace packages/core \
  && npm run build --workspace apps/control-plane

# A second install into a throwaway tree rather than pruning the tree above.
# Pruning at the workspace root would keep the console's production
# dependencies — Next.js and React, hundreds of megabytes — because npm sees
# them as production deps of a sibling workspace and has no reason to drop them.
FROM node:22-alpine AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/sdk-js/package.json packages/sdk-js/
COPY apps/console/package.json apps/console/
COPY apps/control-plane/package.json apps/control-plane/
RUN npm ci --omit=dev --workspace apps/control-plane --include-workspace-root


FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# node:alpine already carries an unprivileged `node` user, so there is nothing
# to create here — only ownership to hand over.
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/package.json ./package.json

# The directory layout has to survive into the runtime image unchanged: the
# node_modules/@flagship/core entry is a symlink to ../../packages/core, and
# db.ts locates its SQL by walking up from its own compiled location.
COPY --from=build --chown=node:node /app/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/apps/control-plane/package.json ./apps/control-plane/package.json
COPY --from=build --chown=node:node /app/apps/control-plane/dist ./apps/control-plane/dist
COPY --from=build --chown=node:node /app/apps/control-plane/migrations ./apps/control-plane/migrations

USER node
EXPOSE 4000

# Absolute path on purpose. server.ts decides whether it is the entry point by
# comparing import.meta.url against argv[1], and a relative argument makes that
# comparison depend on the working directory the container happens to start in.
CMD ["node", "/app/apps/control-plane/dist/server.js"]
