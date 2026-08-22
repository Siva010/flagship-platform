# Build context is the repository root so that one .dockerignore governs all
# three service builds, even though this module needs nothing outside its own
# directory.
#
#   docker build -f apps/data-plane/Dockerfile -t flagship-data-plane .

FROM golang:1.23-alpine AS build
WORKDIR /src

COPY apps/data-plane/go.mod ./
RUN go mod download

COPY apps/data-plane ./

# CGO off is what makes the binary self-contained; without it the Go toolchain
# links against Alpine's musl and the result depends on the base image it was
# compiled on. -trimpath keeps build-machine paths out of panic traces.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/dataplane ./cmd/dataplane


# Alpine rather than distroless/static, which would be a few megabytes smaller.
# Distroless has no shell and no HTTP client, so nothing inside it can execute a
# container healthcheck against /healthz — the orchestrator would have to probe
# from outside. Busybox wget is worth the size for a service whose entire job is
# holding connections that need to be observed.
FROM alpine:3.21 AS runtime

RUN adduser --disabled-password --gecos '' --uid 10001 dataplane
COPY --from=build /out/dataplane /usr/local/bin/dataplane

USER dataplane
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/dataplane"]
