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

## Measured results

Reproduce either of these yourself; both are deterministic.

**Evaluation latency** (`npm run bench`) — node 24.17, win32 x64, 200 flags × 5 rules, 2M iterations, in-process, no network I/O:

| Path | ns/op |
|---|---|
| miss all rules → default | 241 |
| match rule + rollout | 716 |
| `isEnabled` | 712 |
| varying flag key across 200 flags | 827 |

The first benchmark read ~2000 ns/op. Three hot-path allocations were responsible — `TextEncoder.encode` allocating per hash, a `Set` allocated per rule for cycle detection, and a linear `variations.find()` with a closure per evaluation. None of it was the hash.

**The peeking problem** (`npm run aa:simulate`) — 1000 simulated A/A experiments, 20k users/arm, 10% baseline, α=0.05, checked every 500 users:

| Strategy | False positive rate |
|---|---|
| Fixed horizon, one look at the end | 5.1% (nominal 5%) |
| Fixed horizon, peeking continuously | **27.4%** |
| mSPRT, peeking continuously | **1.0%** |

Both arms draw from the same distribution, so every rejection is a false positive. The middle row is what most teams actually do.

## Status

Core is implemented and tested; the distributed system around it is not.

**Done** — deterministic bucketing with cross-language conformance (500 cases, TypeScript + Go), the rule evaluation engine, in-process SDK evaluation, payload filtering by key type, and the statistics engine.

**Not started** — SSE streaming and the data-plane fan-out, exposure event ingest, the control-plane API and Postgres schema, the console UI, and the Java SDK.

## Commands

```bash
npm run build          # all workspaces
npm test               # 92 tests
npm run conformance    # 500-case cross-language fixture
npm run bench          # evaluation latency
npm run aa:simulate    # the A/A false-positive measurement
npm run infra:up       # Postgres, Redis, ClickHouse
```
