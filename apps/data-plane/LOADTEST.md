# Data plane load test

Measures how many SSE connections one node holds, what each costs, and how fast
a publish reaches them.

```bash
go build -o bin/dataplane.exe ./cmd/dataplane && go build -o bin/loadtest.exe ./cmd/loadtest
```

```bash
PUBLISH_TOKEN=loadtest-token ADDR=:8503 ./bin/dataplane.exe
```

```bash
./bin/loadtest.exe -addr http://localhost:8503 -token loadtest-token -connections 5000 -rounds 3
```

## Why not k6

k6 has no native SSE support. Using it requires building a custom binary with
the `xk6-sse` extension — which needs a Go toolchain anyway. Writing the harness
directly buys two things worth more than the tooling brand:

- Publish and receipt happen in one process against one clock, so propagation
  latency needs no cross-machine clock synchronisation. Skew between two
  machines is routinely larger than the number being measured.
- The publish payload carries the send timestamp, so each subscriber's latency
  is end-to-end rather than inferred from a request rate.

## Results

Conditions: Intel i5-8600K (6 cores), Windows 11, Go 1.26, **load generator
co-located with the server**. Those conditions matter more than the numbers —
see the caveats.

| Measurement | Result |
|---|---|
| Concurrent SSE connections held | **4,305** |
| Heap per connection | **~18.1 KB** |
| Connection establishment rate | ~1,900/sec (at ≤2,000) |
| Slow-consumer evictions under load | **0** |
| Goroutines at 4,305 connections | 8,615 (2 per connection) |
| Propagation p50, 1 connection | **1.6 ms** |
| Propagation p50 / p99, 4,305 connections | 19 ms / 29 ms |
| Broadcast fan-out CPU, 1,000 subscribers | **117 µs** (Go benchmark, in-process) |

Heap per connection was measured independently at 500, 2,000, and 4,305
connections and came out at 18,184 / 18,105 / 18,178 bytes. That consistency is
the reason to trust it.

## What these numbers do and do not say

**Trustworthy:** connections held, memory per connection, eviction count, and
the in-process fan-out benchmark. None depend on client-side timing.

**Upper bounds, not server properties:**

- **The 4,305 ceiling is the load generator's, not the server's.** 695 of 5,000
  connections failed during the ramp; the server log recorded no errors, no
  evictions, and reported all 4,305 as connected. Windows' default ephemeral
  port range is 16,384, and TIME_WAIT from prior runs eats into it. Measuring
  the real ceiling needs the generator on separate hosts.

- **Latency at high connection counts is inflated by co-location.** With 4,305
  reader goroutines in the generator competing with 8,615 server goroutines on
  six cores, the tail measures scheduler contention as much as propagation. The
  single-connection p50 of 1.6 ms is the honest floor for the full path
  (publish HTTP POST → broadcast → SSE receipt).

- **Windows timer granularity (~15.6 ms) quantises the tail.** Single-connection
  runs show a 1.2–1.6 ms median with occasional 12 ms spikes and nothing in
  between, which is the signature of scheduler quantisation rather than network
  or server behaviour. This platform cannot resolve sub-millisecond propagation.

## Reproducing more honestly

Run the generator on a different machine from the server, on Linux, and raise
the ephemeral port range. That removes all three caveats above and would give a
defensible p99 rather than an upper bound.
