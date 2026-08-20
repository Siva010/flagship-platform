package hub

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func message(version int64) Message {
	return Message{
		ID:      fmt.Sprintf("v%d", version),
		Event:   "ruleset",
		Data:    []byte(`{}`),
		Version: version,
	}
}

func TestBroadcastReachesEverySubscriber(t *testing.T) {
	h := New(Options{Shards: 8, BufferSize: 4})

	subscribers := make([]*Subscriber, 100)
	for i := range subscribers {
		subscribers[i] = h.Subscribe(fmt.Sprintf("sub-%d", i), "production")
	}

	delivered, dropped := h.Broadcast("production", message(1))
	if delivered != 100 || dropped != 0 {
		t.Fatalf("delivered=%d dropped=%d, want 100/0", delivered, dropped)
	}

	for _, subscriber := range subscribers {
		select {
		case got := <-subscriber.Messages():
			if got.Version != 1 {
				t.Errorf("version = %d, want 1", got.Version)
			}
		default:
			t.Errorf("subscriber %s received nothing", subscriber.ID())
		}
	}
}

func TestBroadcastIsScopedToEnvironment(t *testing.T) {
	h := New(Options{Shards: 4, BufferSize: 4})

	prod := h.Subscribe("a", "production")
	staging := h.Subscribe("b", "staging")

	delivered, _ := h.Broadcast("production", message(1))
	if delivered != 1 {
		t.Fatalf("delivered = %d, want 1", delivered)
	}

	if len(prod.Messages()) != 1 {
		t.Error("production subscriber should have a message")
	}
	if len(staging.Messages()) != 0 {
		t.Error("staging subscriber must not receive production traffic")
	}
}

// TestSlowConsumerDoesNotBlockOthers is the reason this package exists.
//
// One subscriber never drains its buffer. Every other subscriber must still
// receive every message, and the broadcaster must never wait on the slow one.
//
// Draining is synchronous between broadcasts rather than in background
// goroutines. That keeps the test deterministic: with an unthrottled broadcast
// loop the scheduler alone decides who keeps up, and every subscriber is
// legitimately "slow" -- which is real behaviour, but not the property under
// test here. See TestBufferSizeBoundsBurstTolerance for that case.
func TestSlowConsumerDoesNotBlockOthers(t *testing.T) {
	const bufferSize = 4
	h := New(Options{Shards: 8, BufferSize: bufferSize})

	slow := h.Subscribe("slow", "production")

	fast := make([]*Subscriber, 50)
	for i := range fast {
		fast[i] = h.Subscribe(fmt.Sprintf("fast-%d", i), "production")
	}

	received := make([]int, len(fast))

	const broadcasts = 200
	started := time.Now()
	for version := 1; version <= broadcasts; version++ {
		h.Broadcast("production", message(int64(version)))

		// Every fast subscriber drains immediately, so it never falls behind.
		for i, subscriber := range fast {
			select {
			case <-subscriber.Messages():
				received[i]++
			default:
			}
		}
	}
	elapsed := time.Since(started)

	// The broadcaster must never have waited on the slow subscriber. Without
	// the non-blocking send this loop would deadlock, not merely slow down.
	if elapsed > 2*time.Second {
		t.Fatalf("broadcast took %v; a slow consumer stalled the broadcaster", elapsed)
	}

	// The slow subscriber must have been evicted rather than tolerated.
	select {
	case <-slow.Done():
		if reason := slow.DropReason(); reason != DropSlowConsumer {
			t.Errorf("drop reason = %v, want slow_consumer", reason)
		}
	case <-time.After(time.Second):
		t.Fatal("slow subscriber was never evicted")
	}

	// Every fast subscriber received every message despite the slow one.
	for i, count := range received {
		if count != broadcasts {
			t.Errorf("fast subscriber %d received %d of %d messages", i, count, broadcasts)
		}
	}

	if stats := h.Stats(); stats.SlowConsumers != 1 {
		t.Errorf("slow consumer count = %d, want exactly 1", stats.SlowConsumers)
	}
}

// TestBufferSizeBoundsBurstTolerance documents the real trade-off: the buffer
// is how far behind a client may fall before eviction. A broadcaster that
// outruns its consumers evicts them, by design -- there is no third option
// besides blocking (which stalls everyone) or unbounded memory growth.
func TestBufferSizeBoundsBurstTolerance(t *testing.T) {
	const bufferSize = 8
	h := New(Options{Shards: 4, BufferSize: bufferSize})

	subscriber := h.Subscribe("never-drains", "production")

	// Exactly bufferSize messages fit.
	for i := 1; i <= bufferSize; i++ {
		delivered, dropped := h.Broadcast("production", message(int64(i)))
		if delivered != 1 || dropped != 0 {
			t.Fatalf("broadcast %d: delivered=%d dropped=%d, want 1/0", i, delivered, dropped)
		}
	}

	// The next one has nowhere to go.
	delivered, dropped := h.Broadcast("production", message(bufferSize+1))
	if delivered != 0 || dropped != 1 {
		t.Fatalf("overflow broadcast: delivered=%d dropped=%d, want 0/1", delivered, dropped)
	}

	select {
	case <-subscriber.Done():
	case <-time.After(time.Second):
		t.Fatal("subscriber should have been evicted on overflow")
	}
}

func TestEvictedSubscriberIsRemovedFromRegistry(t *testing.T) {
	h := New(Options{Shards: 4, BufferSize: 1})

	slow := h.Subscribe("slow", "production")

	// Overflow the buffer: one fits, the next evicts.
	h.Broadcast("production", message(1))
	h.Broadcast("production", message(2))

	select {
	case <-slow.Done():
	case <-time.After(time.Second):
		t.Fatal("subscriber was not evicted")
	}

	if connected := h.Stats().Connected; connected != 0 {
		t.Errorf("connected = %d after eviction, want 0", connected)
	}

	// A further broadcast must not find it.
	delivered, dropped := h.Broadcast("production", message(3))
	if delivered != 0 || dropped != 0 {
		t.Errorf("delivered=%d dropped=%d after eviction, want 0/0", delivered, dropped)
	}
}

func TestUnsubscribeIsIdempotent(t *testing.T) {
	h := New(Options{Shards: 4, BufferSize: 4})
	subscriber := h.Subscribe("a", "production")

	h.Unsubscribe(subscriber)
	h.Unsubscribe(subscriber) // must not panic or double-count

	if connected := h.Stats().Connected; connected != 0 {
		t.Errorf("connected = %d, want 0", connected)
	}
}

// TestConcurrentSubscribeBroadcastUnsubscribe is the race-detector target.
// Run with -race.
func TestConcurrentSubscribeBroadcastUnsubscribe(t *testing.T) {
	h := New(Options{Shards: 16, BufferSize: 8})

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Churn: subscribe and unsubscribe continuously.
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := 0; ; i++ {
				select {
				case <-stop:
					return
				default:
				}
				s := h.Subscribe(fmt.Sprintf("w%d-%d", id, i), "production")
				go func() {
					for {
						select {
						case <-s.Messages():
						case <-s.Done():
							return
						}
					}
				}()
				h.Unsubscribe(s)
			}
		}(worker)
	}

	// Broadcast continuously.
	for worker := 0; worker < 4; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for version := int64(0); ; version++ {
				select {
				case <-stop:
					return
				default:
				}
				h.Broadcast("production", message(version))
			}
		}()
	}

	time.Sleep(300 * time.Millisecond)
	close(stop)
	wg.Wait()

	h.CloseAll()
	if connected := h.Stats().Connected; connected != 0 {
		t.Errorf("connected = %d after CloseAll, want 0", connected)
	}
}

func TestCloseAllDisconnectsEveryone(t *testing.T) {
	h := New(Options{Shards: 4, BufferSize: 4})

	subscribers := make([]*Subscriber, 20)
	for i := range subscribers {
		subscribers[i] = h.Subscribe(fmt.Sprintf("s%d", i), "production")
	}

	h.CloseAll()

	for _, subscriber := range subscribers {
		select {
		case <-subscriber.Done():
		case <-time.After(time.Second):
			t.Fatalf("subscriber %s was not closed", subscriber.ID())
		}
	}
	if connected := h.Stats().Connected; connected != 0 {
		t.Errorf("connected = %d, want 0", connected)
	}
}

func BenchmarkBroadcast1000Subscribers(b *testing.B) {
	h := New(Options{Shards: 32, BufferSize: 64})

	for i := 0; i < 1000; i++ {
		s := h.Subscribe(fmt.Sprintf("s%d", i), "production")
		go func(s *Subscriber) {
			for {
				select {
				case <-s.Messages():
				case <-s.Done():
					return
				}
			}
		}(s)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h.Broadcast("production", message(int64(i)))
	}
	b.StopTimer()
	h.CloseAll()
}
