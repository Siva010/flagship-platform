# Design decisions

The reasoning behind the parts of this system where the obvious approach is
wrong. Each section states a decision, why the alternatives were rejected, and
what evidence supports it.

---

## SSE fan-out

`apps/data-plane/internal/hub/hub.go`

### Why a slow consumer is dropped rather than buffered

There are three options and the other two are worse.

**Block**, and one client on a slow network stalls every other subscriber queued
behind it — head-of-line blocking. With thousands of long-lived connections, a
single bad client degrades the whole fleet.

**Buffer without bound**, and memory grows during exactly the incident that
caused the backlog.

**Evict**, and the cost of being slow is paid by the slow client alone: it
reconnects and resyncs from a snapshot.

Buffer size is not a resolution of that trade-off — it is only where the line is
drawn. Here it is 16 messages.

> **Measured:** zero evictions across 4,305 connections and 12,915 message
> deliveries under load.

### Why `Broadcast` collects evictions instead of removing inline

It would deadlock. `Broadcast` holds a **read** lock on the shard while iterating
its subscribers, and `remove` needs the **write** lock on that same shard. Go's
`RWMutex` is not upgradable, so calling `remove` inside the loop would block
forever waiting for a lock the caller itself holds.

Evictions are appended to a slice, the read lock is released, and only then are
they performed.

### Why the registry is sharded

One mutex over a global map serialises every connect, disconnect and broadcast
across all cores. At thousands of connections that single lock becomes the
bottleneck regardless of core count. Subscribers are distributed across 32
independent shards, each with its own lock.

> **Measured:** 117 µs to fan out to 1,000 subscribers; 2 allocations per
> broadcast total, not per subscriber.

---

## Always-valid sequential testing

`packages/core/src/stats/sequential.ts`

### The problem this solves

A fixed-horizon p-value is only valid if you look once, at a sample size chosen
in advance. Teams instead watch a dashboard and stop when it turns green — an
optional stopping rule the mathematics never accounted for. Every additional look
is another chance to cross the threshold by luck.

> **Measured** (`npm run aa:simulate`) — 1,000 simulated A/A experiments, 39
> looks each:
>
> | Strategy | False positive rate |
> |---|---|
> | Fixed horizon, one look at the end | 5.1% (nominal 5%) |
> | Fixed horizon, peeking continuously | **27.4%** |
> | mSPRT, peeking continuously | **1.0%** |

### Why mSPRT fixes it

Its mixture likelihood ratio is a **martingale under the null hypothesis**.
Ville's inequality then bounds the probability that the ratio *ever* exceeds 1/α
across the entire sequence, rather than at a single point.

That is the whole difference: the fixed-horizon guarantee is pointwise, the
always-valid one is uniform over time. It therefore holds at any stopping rule,
including one chosen by a human watching a dashboard.

### What `tau` is, and what this costs

`tau` is the mixing standard deviation — roughly the effect size considered
plausible before seeing data. It trades sensitivity across the effect range: too
small and large true effects are detected slowly, too large and small ones are.
Setting it near the minimum detectable effect is the usual advice.

The cost is **power**. On identical data the always-valid p-value is always
larger than the fixed-horizon one, and its intervals are strictly wider. You are
buying the right to stop whenever you like, and it is not free — a method that
offered continuous monitoring at no cost would be wrong.

Both properties are asserted in tests rather than only documented.

---

## Payload filtering by SDK key type

`packages/core/src/visibility.ts`

### Why the whole rule is dropped, not just the server-only condition

Removing a node from a boolean tree changes what the tree means.

Take `plan == pro AND email endsWith "@competitor.com"`. Strip the second
condition and what remains is `plan == pro` — **more permissive** than the author
wrote. The flag would be enabled for exactly the users they excluded.

Dropping the rule whole fails closed. A client payload may be *less* inclusive
than the server payload, never more.

> **Tested** as a property across attribute combinations: anyone the client
> payload enables must also be enabled by the server payload.

### Segment references

Safety propagates transitively, computed to a fixed point: a segment referencing
an unsafe segment is itself unsafe. Segments caught in a reference cycle never
become safe, which is the correct conservative answer rather than a limitation.

---

## Cross-language bucketing

`packages/core/src/murmur.ts` · `sdks/go/murmur.go` ·
`sdks/java/src/com/flagship/sdk/MurmurHash3.java`

### Why agreement between the three implementations is not sufficient

Three implementations written by one author from one spec can share a misreading
and agree with each other while all being wrong. The 500-case fixture proves they
agree; it cannot prove they are right.

So each implementation is **also** checked against published smhasher reference
vectors written by nobody here: `""` → 0, `"Hello, world!"` → `0xc0363e43`.

### Why the fixture carries non-ASCII

The traps differ by language, and ASCII-only cases would hide all of them.

- **JavaScript** numbers are doubles, so multiplying two uint32s loses low bits
  to float rounding — hence `Math.imul`. And `<<` / `|` yield *signed* int32,
  hence `>>> 0` after every step.
- **Java** has no unsigned int. Every right shift is `>>>`, every byte read is
  masked `& 0xff`, and the value widens to `long` at the boundary so a uint32
  cannot reach a caller wearing a sign bit.
- **Go** needs neither: uint32 wraps natively and strings are already UTF-8.

A UTF-16 encoding mistake fails all 500 cases; a missing `& 0xff` fails only the
multi-byte ones. That is why `ユーザー`, `é` and `🎉` are in the fixture.

---

## Measured figures and their conditions

No figure here is meaningful without its conditions. They are stated alongside.

| Measurement | Figure | Conditions and limits |
|---|---|---|
| Heap per SSE connection | ~18.1 KB | Measured independently at 500 / 2,000 / 4,305 connections: 18,184 / 18,105 / 18,178 bytes. The consistency is why this is the number worth quoting. |
| Connections held on one node | 4,305 | This is the **load generator's** ceiling, not the server's. 695 of 5,000 failed client-side; the server logged no errors and reported all 4,305 connected. |
| Broadcast to 1,000 subscribers | 117 µs | In-process Go benchmark, so unaffected by client scheduling. |
| Flag evaluation | 241–827 ns | 200 flags × 5 rules, 2M iterations, no network I/O. Was ~2,000 ns until profiling found three hot-path allocations — none of them the hash. |
| Propagation, single connection | 1.6 ms p50 | Windows' ~15.6 ms timer granularity quantises the tail; this platform cannot resolve sub-millisecond propagation. |
| A/A false positives while peeking | 27.4% | vs 1.0% for mSPRT and 5.1% for a single look. 1,000 experiments, 39 looks each. |

---

## Known gaps

Stated deliberately. These are not oversights.

**Nothing is deployed.** No Terraform, no cloud environment, no OpenTelemetry.
Everything runs locally against Docker.

**Admin authentication is a placeholder.** A shared `ADMIN_TOKEN` environment
variable, not OIDC. SDK keys are properly hashed with constant-time comparison;
the human path is not.

**No conversion events.** Exposures supply the denominator; the numerator has no
table yet, so the statistics engine has never run on real pipeline data.

**The hourly rollup over-counts.** Its materialized view fires per insert and
never observes the duplicate collapse, so the count is inflated by SDK retries.
It is the right signal for diagnosing a retry storm and the wrong number for a
dashboard headline.

**Untested past 4,305 connections.** Removing that limit requires load generators
on separate Linux hosts — see
[apps/data-plane/LOADTEST.md](../apps/data-plane/LOADTEST.md).
