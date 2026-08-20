# Flagship

A multi-tenant feature-flag and A/B experimentation platform. Flag evaluation happens
**in-process** — the SDK holds the whole ruleset in memory and adds zero network I/O to
the host application. Rulesets are pushed over SSE with monotonic versioning, bucketing is
deterministic and identical across languages, and the analysis engine uses always-valid
sequential testing rather than fixed-horizon p-values you peek at.

Design reasoning for the non-obvious parts is in [docs/DESIGN-DECISIONS.md](docs/DESIGN-DECISIONS.md).

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

**SSE fan-out** (see [LOADTEST.md](apps/data-plane/LOADTEST.md)) — i5-8600K (6 cores), Windows 11, load generator co-located with the server:

| Measurement | Result |
|---|---|
| Concurrent SSE connections held | 4,305 |
| Heap per connection | ~18.1 KB |
| Slow-consumer evictions under load | 0 |
| Propagation p50, single connection | 1.6 ms |
| Broadcast fan-out to 1,000 subscribers | 117 µs |

Heap per connection came out at 18,184 / 18,105 / 18,178 bytes at 500 / 2,000 / 4,305 connections — that consistency is why it is the number worth quoting. The 4,305 ceiling is the *load generator's* limit, not the server's: 695 of 5,000 connections failed on the client during the ramp while the server logged no errors and reported all 4,305 connected. Latency above a few hundred connections is inflated by co-location and by Windows' ~15.6 ms timer granularity, so treat it as an upper bound rather than a server property.

## Status

**Done** — 166 tests with all services up, plus the Go suite under `-race` and a Java conformance run:

- **Deterministic bucketing** — MurmurHash3 in **TypeScript, Go, and Java**, each validated against published smhasher vectors rather than only against our own fixture, and all three gated in CI against the same 500 cases. The fixture deliberately carries multi-byte UTF-8, astral-plane characters, and every tail length, because those are what separate a correct port from one that merely agrees on ASCII.
- **Rule evaluation** — nested AND/OR/NOT, reusable segments, flag prerequisites, percentage rollouts. Both recursive structures are cycle-guarded; a malformed ruleset fails closed instead of overflowing the stack inside a customer's request path.
- **In-process SDK evaluation** — never throws, never performs I/O, degrades to the caller's fallback when no ruleset has loaded.
- **Payload filtering by key type** — a rule containing any server-only node is dropped whole rather than rewritten, because stripping a node out of an AND makes it *more* permissive.
- **Statistics** — Welch's t-test, two-proportion z-test, mSPRT, SRM detection, MDE calculator.
- **SSE fan-out** — sharded registry, bounded per-connection buffers, slow-consumer eviction. 117 µs to broadcast to 1000 subscribers.
- **Snapshot store** — monotonic versions, bounded history for `Last-Event-ID` resumption, ETag conditional GET.
- **Control plane** — Postgres schema and migration runner, hashed API keys with indexed-prefix lookup, a ruleset compiler that rejects invalid publishes rather than shipping them, publish transaction with per-environment version locking, append-only audit log, and an SDK snapshot endpoint that picks the payload from the authenticated key kind.
- **Exposure pipeline** — SDK-side adaptive sampling and hard-bounded queues, ingesting into ClickHouse. Aggregations count `uniqExact(dedupe_key)` rather than rows, so at-least-once redelivery cannot inflate them regardless of whether a background merge has collapsed the duplicates yet.
- **Console** — a recursive rule builder showing the server payload, client payload, and a live evaluation side by side, plus an experiment results view plotting confidence intervals over time. On its default A/A scenario the fixed-horizon interval excludes zero at 17,000 users and then returns to non-significance; the always-valid band never crosses.
- **Publish authentication** — the data-plane ingress is gated by a service token compared in constant time, and fails closed: no token configured disables the endpoint rather than leaving it open.

**Not started** — a console flag-list view, and a conversion-event table (exposures supply the denominator; the numerator still has to come from somewhere).

Integration tests run against a real Postgres and skip cleanly when one is not reachable, so `npm test` stays green without Docker.

## Commands

```bash
npm run build          # all workspaces
npm test               # 166 tests (25 need infra:up; they skip cleanly without it)
npm run conformance    # 500-case fixture, TypeScript SDK
npm run bench          # evaluation latency
npm run aa:simulate    # the A/A false-positive measurement
npm run infra:up       # Postgres (host port 5433), Redis, ClickHouse
```

The Go and Java SDKs check the same fixture. CI runs all three.

```bash
cd apps/data-plane && go test ./... -race
```

```bash
cd sdks/go && go test ./... -run Conformance
```

```bash
cd sdks/java && javac -encoding UTF-8 -d out $(find src test -name '*.java') && java -cp out com.flagship.sdk.ConformanceTest
```
