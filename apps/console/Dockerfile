# Build context is the repository root; see apps/control-plane/Dockerfile for why.
#
#   docker build -f apps/console/Dockerfile -t flagship-console .

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/sdk-js/package.json packages/sdk-js/
COPY apps/console/package.json apps/console/
COPY apps/control-plane/package.json apps/control-plane/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/console ./apps/console

# next.config.mjs lists @flagship/core in transpilePackages, which transpiles the
# files the package actually exports — packages/core/dist. Building core first is
# therefore required, not just tidy.
RUN npm run build --workspace packages/core \
  && npm run build --workspace apps/console

# Telemetry would otherwise attempt a network call during the build.
ENV NEXT_TELEMETRY_DISABLED=1


FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# The standalone server binds 127.0.0.1 unless told otherwise, which inside a
# container means nothing outside it can ever connect.
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# The standalone bundle already contains the traced subset of node_modules, so
# there is no install step here at all. Its internal layout mirrors the
# repository because next.config.mjs sets outputFileTracingRoot to the workspace
# root — hence apps/console/server.js rather than server.js.
COPY --from=build --chown=node:node /app/apps/console/.next/standalone ./

# Static assets are deliberately excluded from the standalone trace so they can
# be served from a CDN instead. Nothing else serves them here, so they have to
# be copied in beside the server that will.
COPY --from=build --chown=node:node /app/apps/console/.next/static ./apps/console/.next/static

USER node
EXPOSE 3000
CMD ["node", "apps/console/server.js"]
