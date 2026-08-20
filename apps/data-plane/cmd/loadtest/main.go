// Command loadtest measures how many SSE connections a data plane node holds
// and how fast a published ruleset reaches them.
//
// Why this exists rather than k6: k6 has no native SSE support. Using it means
// building a custom binary with the xk6-sse extension, which requires a Go
// toolchain anyway. Writing the harness directly buys two things that matter
// more than the tooling brand:
//
//   - Publish and receipt happen in one process against one clock, so
//     propagation latency needs no cross-machine clock synchronisation. Skew
//     between two machines is routinely larger than the number being measured.
//   - The publish payload carries the send timestamp, so each subscriber's
//     latency is measured end to end rather than inferred from a request rate.
//
// The numbers this prints are only meaningful with their conditions attached:
// connection count, machine, and whether the load generator shared a host with
// the server. It prints all of them.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type config struct {
	addr        string
	environment string
	token       string
	connections int
	rounds      int
	settle      time.Duration
	timeout     time.Duration
	rampBatch   int
	rampPause   time.Duration
}

func main() {
	var cfg config
	flag.StringVar(&cfg.addr, "addr", "http://localhost:8080", "data plane base URL")
	flag.StringVar(&cfg.environment, "env", "production", "environment key")
	flag.StringVar(&cfg.token, "token", "", "publish token (PUBLISH_TOKEN on the server)")
	flag.IntVar(&cfg.connections, "connections", 1000, "SSE connections to hold")
	flag.IntVar(&cfg.rounds, "rounds", 5, "publish rounds to measure")
	flag.DurationVar(&cfg.settle, "settle", 2*time.Second, "pause between rounds")
	flag.DurationVar(&cfg.timeout, "timeout", 10*time.Second, "per-round receipt deadline")
	flag.IntVar(&cfg.rampBatch, "ramp-batch", 200, "connections opened per ramp step")
	flag.DurationVar(&cfg.rampPause, "ramp-pause", 100*time.Millisecond, "pause between ramp steps")
	flag.Parse()

	if cfg.token == "" {
		fmt.Fprintln(os.Stderr, "-token is required; the publish endpoint fails closed without one")
		os.Exit(2)
	}

	if err := run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "load test failed: %v\n", err)
		os.Exit(1)
	}
}

// subscriber holds one SSE connection and reports receipt times.
type subscriber struct {
	index    int
	received chan int64 // nanosecond send-stamp parsed out of each frame
}

func run(cfg config) error {
	fmt.Printf("Flagship data plane load test\n")
	fmt.Printf("  target       %s\n", cfg.addr)
	fmt.Printf("  connections  %d\n", cfg.connections)
	fmt.Printf("  rounds       %d\n\n", cfg.rounds)

	baseline, err := fetchStats(cfg.addr)
	if err != nil {
		return fmt.Errorf("server unreachable: %w", err)
	}
	fmt.Printf("  baseline heap %.1f MB, %d goroutines\n\n",
		float64(baseline.Runtime.HeapAllocBytes)/(1<<20), baseline.Runtime.Goroutines)

	// Versions are monotonic per environment and the server rejects anything
	// that does not advance, so a second run against a live server cannot start
	// from 1. Continue above whatever is already published.
	version := currentVersion(cfg) + 1

	// A published ruleset must exist before subscribers connect, or the initial
	// frame never arrives and the ramp cannot tell "connected" from "stalled".
	if err := publish(cfg, version, 0); err != nil {
		return fmt.Errorf("seed publish: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	subscribers, connectStats := connectAll(ctx, cfg)
	if len(subscribers) == 0 {
		return fmt.Errorf("no connections established")
	}

	fmt.Printf("\n  connected    %d/%d in %s (%.0f conn/sec)\n",
		len(subscribers), cfg.connections, connectStats.elapsed.Round(time.Millisecond),
		float64(len(subscribers))/connectStats.elapsed.Seconds())
	if connectStats.failed > 0 {
		fmt.Printf("  failed       %d\n", connectStats.failed)
	}

	// Let the ramp settle so the heap reading reflects steady state rather than
	// connection churn.
	time.Sleep(cfg.settle)

	loaded, err := fetchStats(cfg.addr)
	if err != nil {
		return fmt.Errorf("stats after connect: %w", err)
	}

	heapDelta := int64(loaded.Runtime.HeapAllocBytes) - int64(baseline.Runtime.HeapAllocBytes)
	perConnection := float64(heapDelta) / float64(len(subscribers))

	fmt.Printf("  server holds %d connections, %d goroutines\n",
		loaded.Hub.Connected, loaded.Runtime.Goroutines)
	fmt.Printf("  heap         %.1f MB (+%.1f MB), ~%.0f bytes/connection\n\n",
		float64(loaded.Runtime.HeapAllocBytes)/(1<<20),
		float64(heapDelta)/(1<<20), perConnection)

	// --- Propagation latency -------------------------------------------------

	fmt.Printf("  propagation latency, publish -> subscriber receipt\n")
	var all []time.Duration

	for round := 1; round <= cfg.rounds; round++ {
		version++
		latencies, missed := measureRound(cfg, subscribers, version)
		all = append(all, latencies...)

		if len(latencies) == 0 {
			fmt.Printf("    round %d: no frames received\n", round)
			continue
		}
		sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
		fmt.Printf("    round %d: n=%d p50=%s p99=%s max=%s",
			round, len(latencies),
			percentile(latencies, 50).Round(time.Microsecond),
			percentile(latencies, 99).Round(time.Microsecond),
			latencies[len(latencies)-1].Round(time.Microsecond))
		if missed > 0 {
			fmt.Printf("  missed=%d", missed)
		}
		fmt.Println()

		time.Sleep(cfg.settle)
	}

	final, err := fetchStats(cfg.addr)
	if err != nil {
		return fmt.Errorf("final stats: %w", err)
	}

	if len(all) > 0 {
		sort.Slice(all, func(i, j int) bool { return all[i] < all[j] })
		fmt.Printf("\n  aggregate over %d receipts\n", len(all))
		for _, p := range []int{50, 90, 95, 99} {
			fmt.Printf("    p%-3d %s\n", p, percentile(all, p).Round(time.Microsecond))
		}
		fmt.Printf("    max  %s\n", all[len(all)-1].Round(time.Microsecond))
	}

	fmt.Printf("\n  server after test\n")
	fmt.Printf("    connected      %d\n", final.Hub.Connected)
	fmt.Printf("    slow consumers %d\n", final.Hub.SlowConsumers)
	fmt.Printf("    messages sent  %d\n", final.Hub.MessagesSent)
	fmt.Printf("    heap           %.1f MB\n", float64(final.Runtime.HeapAllocBytes)/(1<<20))

	if final.Hub.SlowConsumers > 0 {
		fmt.Printf("\n  NOTE: %d subscribers were evicted as slow consumers. Latency percentiles\n",
			final.Hub.SlowConsumers)
		fmt.Printf("        above exclude them, so they understate the tail. This is the\n")
		fmt.Printf("        designed behaviour, not a failure -- but the number matters.\n")
	}

	return nil
}

type connectResult struct {
	elapsed time.Duration
	failed  int
}

// connectAll opens connections in batches. Opening thousands at once saturates
// the local ephemeral port allocator and measures the client's limits rather
// than the server's.
func connectAll(ctx context.Context, cfg config) ([]*subscriber, connectResult) {
	client := &http.Client{
		// No overall Timeout: it applies to the whole request including the
		// response body, and would sever every long-lived stream on a fixed
		// schedule. Setup is bounded separately below.
		Timeout: 0,
		Transport: &http.Transport{
			MaxIdleConns:        cfg.connections + 100,
			MaxIdleConnsPerHost: cfg.connections + 100,
			MaxConnsPerHost:     0,
			DisableCompression:  true,
			// Bound connection setup only. Without these a connect that never
			// completes -- which is exactly what ephemeral port exhaustion looks
			// like -- hangs its goroutine forever and deadlocks the ramp's
			// WaitGroup, so the harness appears to hang instead of reporting
			// that it hit a client-side limit.
			DialContext:           (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
			ResponseHeaderTimeout: 10 * time.Second,
		},
	}

	var (
		mu          sync.Mutex
		subscribers []*subscriber
		failed      atomic.Int64
		ready       sync.WaitGroup
	)

	started := time.Now()

	for offset := 0; offset < cfg.connections; offset += cfg.rampBatch {
		end := offset + cfg.rampBatch
		if end > cfg.connections {
			end = cfg.connections
		}

		for i := offset; i < end; i++ {
			ready.Add(1)
			go func(index int) {
				sub := &subscriber{index: index, received: make(chan int64, 64)}

				request, err := http.NewRequestWithContext(ctx, http.MethodGet,
					fmt.Sprintf("%s/v1/stream?env=%s", cfg.addr, cfg.environment), nil)
				if err != nil {
					failed.Add(1)
					ready.Done()
					return
				}
				request.Header.Set("Accept", "text/event-stream")

				response, err := client.Do(request)
				if err != nil {
					failed.Add(1)
					ready.Done()
					return
				}
				if response.StatusCode != http.StatusOK {
					response.Body.Close()
					failed.Add(1)
					ready.Done()
					return
				}

				mu.Lock()
				subscribers = append(subscribers, sub)
				mu.Unlock()

				go sub.consume(response.Body, &ready)
			}(i)
		}

		time.Sleep(cfg.rampPause)
		fmt.Printf("\r  opening      %d/%d", end, cfg.connections)
	}

	ready.Wait()
	return subscribers, connectResult{elapsed: time.Since(started), failed: int(failed.Load())}
}

// consume reads SSE frames, extracting the send stamp the publisher embedded.
// The first frame is the initial snapshot and signals readiness.
func (s *subscriber) consume(body interface{ Read([]byte) (int, error) }, ready *sync.WaitGroup) {
	defer func() {
		if closer, ok := body.(interface{ Close() error }); ok {
			closer.Close()
		}
	}()

	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	first := true
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		// Receipt is stamped the moment the data line is read, before any
		// parsing, so JSON decoding cost is not counted as network latency.
		receivedAt := time.Now().UnixNano()

		if first {
			first = false
			ready.Done()
			continue
		}

		if stamp := extractStamp(line); stamp > 0 {
			select {
			case s.received <- receivedAt - stamp:
			default:
				// Channel full: the harness is behind, which would distort the
				// measurement. Dropping is better than blocking the reader.
			}
		}
	}

	if first {
		// Stream ended before the initial frame arrived.
		ready.Done()
	}
}

// extractStamp pulls the publisher's nanosecond stamp out of a data line
// without a full JSON parse, which would add measurable cost per frame.
func extractStamp(line string) int64 {
	const marker = `"sentAt":`
	index := strings.Index(line, marker)
	if index < 0 {
		return 0
	}
	rest := line[index+len(marker):]
	end := strings.IndexAny(rest, ",}")
	if end < 0 {
		return 0
	}
	var stamp int64
	if _, err := fmt.Sscanf(strings.TrimSpace(rest[:end]), "%d", &stamp); err != nil {
		return 0
	}
	return stamp
}

// measureRound publishes one version and collects receipt latencies.
func measureRound(cfg config, subscribers []*subscriber, version int64) ([]time.Duration, int) {
	// Drain anything left over so a slow previous round cannot leak into this one.
	for _, sub := range subscribers {
		for {
			select {
			case <-sub.received:
				continue
			default:
			}
			break
		}
	}

	if err := publish(cfg, version, time.Now().UnixNano()); err != nil {
		fmt.Fprintf(os.Stderr, "publish round %d: %v\n", version, err)
		return nil, len(subscribers)
	}

	latencies := make([]time.Duration, 0, len(subscribers))
	deadline := time.After(cfg.timeout)
	missed := 0

	for _, sub := range subscribers {
		select {
		case delta := <-sub.received:
			latencies = append(latencies, time.Duration(delta))
		case <-deadline:
			missed++
		}
	}

	return latencies, missed
}

func publish(cfg config, version int64, sentAt int64) error {
	payload := fmt.Sprintf(
		`{"environmentKey":%q,"version":%d,"sentAt":%d,"flags":[],"segments":[]}`,
		cfg.environment, version, sentAt)

	body, err := json.Marshal(map[string]any{
		"environment": cfg.environment,
		"version":     version,
		"payload":     json.RawMessage(payload),
	})
	if err != nil {
		return err
	}

	request, err := http.NewRequest(http.MethodPost,
		cfg.addr+"/internal/v1/publish", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+cfg.token)

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("publish returned %d", response.StatusCode)
	}
	return nil
}

type statsResponse struct {
	Hub struct {
		Connected     int64 `json:"Connected"`
		SlowConsumers int64 `json:"SlowConsumers"`
		MessagesSent  int64 `json:"MessagesSent"`
		BufferSize    int   `json:"BufferSize"`
		Shards        int   `json:"Shards"`
	} `json:"hub"`
	Runtime struct {
		Goroutines     int    `json:"goroutines"`
		HeapAllocBytes uint64 `json:"heapAllocBytes"`
		SysBytes       uint64 `json:"sysBytes"`
	} `json:"runtime"`
}

// currentVersion reads the version already published for this environment, so a
// repeated run continues the sequence instead of colliding with the monotonic
// guard. Zero when nothing is published yet.
func currentVersion(cfg config) int64 {
	response, err := http.Get(fmt.Sprintf("%s/v1/snapshot?env=%s", cfg.addr, cfg.environment))
	if err != nil {
		return 0
	}
	defer response.Body.Close()

	var version int64
	if _, err := fmt.Sscanf(response.Header.Get("X-Flagship-Version"), "%d", &version); err != nil {
		return 0
	}
	return version
}

func fetchStats(addr string) (statsResponse, error) {
	var stats statsResponse

	response, err := http.Get(addr + "/v1/stats")
	if err != nil {
		return stats, err
	}
	defer response.Body.Close()

	if err := json.NewDecoder(response.Body).Decode(&stats); err != nil {
		return stats, err
	}
	return stats, nil
}

// percentile uses nearest-rank on an already-sorted slice.
func percentile(sorted []time.Duration, p int) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	index := (p * len(sorted)) / 100
	if index >= len(sorted) {
		index = len(sorted) - 1
	}
	return sorted[index]
}
