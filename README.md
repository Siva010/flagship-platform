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

**Done** — 129 tests, plus the Go suite under `-race`:

- **Deterministic bucketing** — MurmurHash3, validated against published smhasher vectors rather than only against itself, with a 500-case fixture run against both the TypeScript and Go implementations.
- **Rule evaluation** — nested AND/OR/NOT, reusable segments, flag prerequisites, percentage rollouts. Both recursive structures are cycle-guarded; a malformed ruleset fails closed instead of overflowing the stack inside a customer's request path.
- **In-process SDK evaluation** — never throws, never performs I/O, degrades to the caller's fallback when no ruleset has loaded.
- **Payload filtering by key type** — a rule containing any server-only node is dropped whole rather than rewritten, because stripping a node out of an AND makes it *more* permissive.
- **Statistics** — Welch's t-test, two-proportion z-test, mSPRT, SRM detection, MDE calculator.
- **SSE fan-out** — sharded registry, bounded per-connection buffers, slow-consumer eviction. 117 µs to broadcast to 1000 subscribers.
- **Snapshot store** — monotonic versions, bounded history for `Last-Event-ID` resumption, ETag conditional GET.
- **Control plane** — Postgres schema, hashed API keys with indexed-prefix lookup, and a ruleset compiler that rejects invalid publishes rather than shipping them.
- **Exposure pipeline** — adaptive sampling, hard-bounded queues, non-blocking recording.

**Not started** — the console UI, the Java SDK, control-plane HTTP routes wired to Postgres, and the ClickHouse ingest sink.

## Commands

```bash
npm run build          # all workspaces
npm test               # 129 tests
npm run conformance    # 500-case cross-language fixture
npm run bench          # evaluation latency
npm run aa:simulate    # the A/A false-positive measurement
npm run infra:up       # Postgres, Redis, ClickHouse
```

```bash
cd apps/data-plane && go test ./... -race
```
