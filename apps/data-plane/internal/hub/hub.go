// Package hub holds the fan-out registry for streaming subscribers.
//
// The problem this package solves is head-of-line blocking. A naive broadcast
// writes to each subscriber in turn; one subscriber on a slow network stalls
// its write, and every subscriber behind it waits. With thousands of long-lived
// connections, a single bad client degrades the whole fleet.
//
// Two decisions follow from that:
//
//   - Every subscriber owns a bounded buffer. Broadcast never blocks: it does a
//     non-blocking send and, on a full buffer, drops the subscriber rather than
//     waiting. A dropped subscriber reconnects and resyncs from a snapshot, so
//     the cost of being slow is paid by the slow client alone.
//
//   - The registry is sharded. One mutex over a global map serialises every
//     connect, disconnect, and broadcast across all cores; at thousands of
//     connections that lock becomes the bottleneck. Subscribers are distributed
//     across independent shards, each with its own lock.
package hub

import (
	"hash/fnv"
	"sync"
	"sync/atomic"
)

// Message is one server-sent event.
type Message struct {
	// ID becomes the SSE id: field, which clients echo back as Last-Event-ID.
	ID string
	// Event is the SSE event: field.
	Event string
	// Data is the payload, already serialized.
	Data []byte
	// Version is the ruleset version this message carries.
	Version int64
}

// DropReason explains why a subscriber was removed.
type DropReason int

const (
	// DropClosed means the client disconnected or the server shut down.
	DropClosed DropReason = iota
	// DropSlowConsumer means the subscriber could not keep up and was evicted.
	// The client must reconnect and resync from a snapshot.
	DropSlowConsumer
)

func (r DropReason) String() string {
	switch r {
	case DropSlowConsumer:
		return "slow_consumer"
	default:
		return "closed"
	}
}

// Subscriber is one connected client.
type Subscriber struct {
	id          string
	environment string

	// messages is bounded. Its capacity is how far behind a client may fall
	// before it is evicted.
	messages chan Message

	closeOnce sync.Once
	done      chan struct{}
	reason    atomic.Int32
}

// ID returns the subscriber's unique identifier.
func (s *Subscriber) ID() string { return s.id }

// Environment returns the environment this subscriber is streaming.
func (s *Subscriber) Environment() string { return s.environment }

// Messages is the channel the connection handler reads from.
func (s *Subscriber) Messages() <-chan Message { return s.messages }

// Done is closed when the subscriber is removed, for any reason.
func (s *Subscriber) Done() <-chan struct{} { return s.done }

// DropReason reports why the subscriber was removed. Only meaningful after Done
// is closed.
func (s *Subscriber) DropReason() DropReason { return DropReason(s.reason.Load()) }

// close is idempotent so a concurrent eviction and disconnect cannot double-close.
func (s *Subscriber) close(reason DropReason) {
	s.closeOnce.Do(func() {
		s.reason.Store(int32(reason))
		close(s.done)
		// messages is deliberately not closed: the broadcaster may still hold a
		// reference and would panic sending on a closed channel. Readers select
		// on Done instead.
	})
}

type shard struct {
	mu sync.RWMutex
	// Indexed by environment so a broadcast touches only relevant subscribers.
	byEnvironment map[string]map[string]*Subscriber
}

// Hub is a sharded registry of streaming subscribers. Safe for concurrent use.
type Hub struct {
	shards []*shard

	bufferSize int

	connected     atomic.Int64
	totalDropped  atomic.Int64
	slowConsumers atomic.Int64
	sent          atomic.Int64
}

// Options configures a Hub.
type Options struct {
	// Shards is the number of independent lock domains. Should exceed GOMAXPROCS
	// so concurrent operations rarely contend. Defaults to 32.
	Shards int
	// BufferSize bounds each subscriber's queue. Larger tolerates burstier
	// clients at the cost of memory per connection; smaller evicts sooner.
	// Defaults to 16.
	BufferSize int
}

// New creates a Hub.
func New(options Options) *Hub {
	shardCount := options.Shards
	if shardCount <= 0 {
		shardCount = 32
	}
	bufferSize := options.BufferSize
	if bufferSize <= 0 {
		bufferSize = 16
	}

	shards := make([]*shard, shardCount)
	for i := range shards {
		shards[i] = &shard{byEnvironment: make(map[string]map[string]*Subscriber)}
	}

	return &Hub{shards: shards, bufferSize: bufferSize}
}

func (h *Hub) shardFor(id string) *shard {
	hasher := fnv.New32a()
	_, _ = hasher.Write([]byte(id))
	return h.shards[hasher.Sum32()%uint32(len(h.shards))]
}

// Subscribe registers a new subscriber for an environment.
func (h *Hub) Subscribe(id, environment string) *Subscriber {
	subscriber := &Subscriber{
		id:          id,
		environment: environment,
		messages:    make(chan Message, h.bufferSize),
		done:        make(chan struct{}),
	}

	target := h.shardFor(id)
	target.mu.Lock()
	byID, ok := target.byEnvironment[environment]
	if !ok {
		byID = make(map[string]*Subscriber)
		target.byEnvironment[environment] = byID
	}
	byID[id] = subscriber
	target.mu.Unlock()

	h.connected.Add(1)
	return subscriber
}

// Unsubscribe removes a subscriber. Safe to call more than once.
func (h *Hub) Unsubscribe(subscriber *Subscriber) {
	h.remove(subscriber, DropClosed)
}

func (h *Hub) remove(subscriber *Subscriber, reason DropReason) {
	target := h.shardFor(subscriber.id)

	target.mu.Lock()
	byID, ok := target.byEnvironment[subscriber.environment]
	if ok {
		if _, present := byID[subscriber.id]; present {
			delete(byID, subscriber.id)
			if len(byID) == 0 {
				delete(target.byEnvironment, subscriber.environment)
			}
			h.connected.Add(-1)
			h.totalDropped.Add(1)
			if reason == DropSlowConsumer {
				h.slowConsumers.Add(1)
			}
		}
	}
	target.mu.Unlock()

	subscriber.close(reason)
}

// Broadcast delivers a message to every subscriber of an environment.
//
// It never blocks on a slow subscriber. Delivery is attempted without blocking;
// a subscriber whose buffer is full is evicted and must resync. The returned
// counts are deliveries and evictions.
func (h *Hub) Broadcast(environment string, message Message) (delivered, dropped int) {
	// Collect evictions and perform them after releasing the read lock, since
	// remove takes the write lock on the same shard.
	var evict []*Subscriber

	for _, target := range h.shards {
		target.mu.RLock()
		for _, subscriber := range target.byEnvironment[environment] {
			select {
			case subscriber.messages <- message:
				delivered++
			default:
				// Buffer full: this client is behind. Dropping it here is the
				// entire point -- blocking would stall every other subscriber.
				evict = append(evict, subscriber)
			}
		}
		target.mu.RUnlock()
	}

	for _, subscriber := range evict {
		h.remove(subscriber, DropSlowConsumer)
		dropped++
	}

	h.sent.Add(int64(delivered))
	return delivered, dropped
}

// CloseAll disconnects every subscriber, for shutdown.
func (h *Hub) CloseAll() {
	for _, target := range h.shards {
		target.mu.Lock()
		for environment, byID := range target.byEnvironment {
			for id, subscriber := range byID {
				subscriber.close(DropClosed)
				delete(byID, id)
				h.connected.Add(-1)
			}
			delete(target.byEnvironment, environment)
		}
		target.mu.Unlock()
	}
}

// Stats is a point-in-time snapshot of hub counters.
type Stats struct {
	Connected     int64
	TotalDropped  int64
	SlowConsumers int64
	MessagesSent  int64
	Shards        int
	BufferSize    int
}

// Stats returns current counters.
func (h *Hub) Stats() Stats {
	return Stats{
		Connected:     h.connected.Load(),
		TotalDropped:  h.totalDropped.Load(),
		SlowConsumers: h.slowConsumers.Load(),
		MessagesSent:  h.sent.Load(),
		Shards:        len(h.shards),
		BufferSize:    h.bufferSize,
	}
}
