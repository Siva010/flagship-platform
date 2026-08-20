# Flagship

A multi-tenant feature-flag and A/B experimentation platform. Flag evaluation happens
**in-process** — the SDK holds the whole ruleset in memory and adds zero network I/O to
the host application. Rulesets are pushed over SSE with monotonic versioning, bucketing is
deterministic and identical across languages, and the analysis engine uses always-valid
sequential testing rather than fixed-horizon p-values you peek at.

## The hard parts

- **In-process evaluation.** A flag is checked hundreds of times per request. It cannot
  make a network call. Everything in the architecture follows from this.
- **Cross-language determinism.** The TypeScript, Go, and Java SDKs must bucket a user
  identically. One spec ([spec/BUCKETING.md](spec/BUCKETING.md)), one shared conformance
  fixture, run in CI against every SDK.
- **SSE fan-out under slow consumers.** Thousands of long-lived connections behind a
  sharded registry; each connection gets a bounded buffer, and on overflow the connection
  is dropped and forced to resync rather than blocking the broadcaster.
- **Version ordering.** Every environment has a monotonic version. SDKs reject any payload
  older than what they hold, so out-of-order delivery cannot corrupt state. Cache
  invalidation is by version bump, never by delete — a stale read is *old but valid*,
  never *missing*.
- **Payload filtering by key type.** Client-side keys ship in browser bundles. A rule like
  `email endsWith @competitor.com` must never reach a client SDK. One rule tree, two
  serialization paths.
- **The peeking problem.** A fixed-horizon t-test checked continuously produces false
  positives far above 5%. mSPRT does not. Both are implemented, and 1000 simulated A/A
  tests measure the difference.

## Layout

```
apps/
  console/         Next.js App Router console
  control-plane/   Fastify + TypeScript — admin CRUD, auth, audit, rule validation
  data-plane/      Go — snapshot serving and SSE fan-out
packages/
  core/            Shared wire types; the contract between every component
  sdk-js/          TypeScript SDK
sdks/
  go/              Go SDK
  java/            Java SDK
spec/              Normative bucketing spec + cross-language conformance fixtures
infra/             Local Postgres, Redis, ClickHouse
```

The control/data split is deliberate: the control plane is low-traffic and
high-complexity, the data plane is high-traffic and low-complexity. Different scaling
profiles, different languages, different deployment cadence.

## Prerequisites

Node 22+, Go 1.23+, Docker, and a JDK for the Java SDK.

## Getting started

```bash
npm install
```

```bash
npm run infra:up
```

```bash
npm run build
```

## Status

Scaffold. Nothing below the type contracts is implemented yet.
