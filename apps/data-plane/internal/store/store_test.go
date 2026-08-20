package store

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/flagship/data-plane/internal/hub"
)

func TestPublishAndCurrent(t *testing.T) {
	s := New(nil, 8)

	if _, err := s.Current("production"); !errors.Is(err, ErrUnknownEnvironment) {
		t.Errorf("err = %v, want ErrUnknownEnvironment", err)
	}

	snapshot, err := s.Publish("production", 1, []byte(`{"v":1}`))
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if snapshot.Version != 1 || snapshot.ETag == "" {
		t.Errorf("snapshot = %+v", snapshot)
	}

	current, err := s.Current("production")
	if err != nil {
		t.Fatalf("current: %v", err)
	}
	if current.Version != 1 {
		t.Errorf("version = %d, want 1", current.Version)
	}
}

// TestPublishRejectsStaleVersions is the monotonicity guard: an out-of-order
// delivery from the control plane must not roll an environment backwards.
func TestPublishRejectsStaleVersions(t *testing.T) {
	s := New(nil, 8)

	if _, err := s.Publish("production", 5, []byte(`{"v":5}`)); err != nil {
		t.Fatalf("publish: %v", err)
	}

	for _, version := range []int64{4, 5} {
		if _, err := s.Publish("production", version, []byte(`{"stale":true}`)); !errors.Is(err, ErrStaleVersion) {
			t.Errorf("publish(%d) err = %v, want ErrStaleVersion", version, err)
		}
	}

	current, _ := s.Current("production")
	if current.Version != 5 {
		t.Errorf("version = %d after stale publishes, want 5", current.Version)
	}
	if string(current.Payload) != `{"v":5}` {
		t.Errorf("payload was overwritten by a stale publish: %s", current.Payload)
	}
}

func TestETagChangesWithPayload(t *testing.T) {
	s := New(nil, 8)

	first, _ := s.Publish("production", 1, []byte(`{"v":1}`))
	second, _ := s.Publish("production", 2, []byte(`{"v":2}`))
	same, _ := s.Publish("production", 3, []byte(`{"v":1}`))

	if first.ETag == second.ETag {
		t.Error("different payloads must have different ETags")
	}
	if first.ETag != same.ETag {
		t.Error("identical payloads must have identical ETags")
	}
}

func TestResumeReplaysOnlyMissedVersions(t *testing.T) {
	s := New(nil, 16)
	for version := int64(1); version <= 5; version++ {
		if _, err := s.Publish("production", version, []byte(fmt.Sprintf(`{"v":%d}`, version))); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}

	missed, needsFullResync, err := s.Resume("production", 2)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if needsFullResync {
		t.Fatal("should not need a full resync within history")
	}
	if len(missed) != 3 {
		t.Fatalf("missed %d versions, want 3", len(missed))
	}
	for i, snapshot := range missed {
		if want := int64(i + 3); snapshot.Version != want {
			t.Errorf("missed[%d].Version = %d, want %d", i, snapshot.Version, want)
		}
	}
}

func TestResumeWhenAlreadyCurrent(t *testing.T) {
	s := New(nil, 16)
	_, _ = s.Publish("production", 3, []byte(`{}`))

	missed, needsFullResync, err := s.Resume("production", 3)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if needsFullResync || len(missed) != 0 {
		t.Errorf("missed=%d fullResync=%v, want 0/false", len(missed), needsFullResync)
	}
}

func TestResumeRequiresFullResyncOutsideHistory(t *testing.T) {
	s := New(nil, 3)
	for version := int64(1); version <= 10; version++ {
		_, _ = s.Publish("production", version, []byte(`{}`))
	}

	_, needsFullResync, err := s.Resume("production", 1)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if !needsFullResync {
		t.Error("a client outside the retained history must resync in full")
	}
}

func TestHistoryStaysBounded(t *testing.T) {
	const historySize = 4
	s := New(nil, historySize)

	for version := int64(1); version <= 100; version++ {
		_, _ = s.Publish("production", version, []byte(`{}`))
	}

	s.mu.RLock()
	length := len(s.environments["production"].history)
	s.mu.RUnlock()

	if length != historySize {
		t.Errorf("history length = %d, want %d -- unbounded history leaks memory", length, historySize)
	}
}

func TestPublishBroadcastsToHub(t *testing.T) {
	h := hub.New(hub.Options{Shards: 2, BufferSize: 4})
	s := New(h, 8)

	subscriber := h.Subscribe("sub", "production")

	if _, err := s.Publish("production", 1, []byte(`{"v":1}`)); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case message := <-subscriber.Messages():
		if message.Version != 1 || message.ID != "1" {
			t.Errorf("message = %+v", message)
		}
		if message.Event != "ruleset" {
			t.Errorf("event = %q, want ruleset", message.Event)
		}
	default:
		t.Fatal("subscriber received nothing")
	}
}

func TestEnvironmentsAreIsolated(t *testing.T) {
	s := New(nil, 8)
	_, _ = s.Publish("production", 5, []byte(`{"env":"prod"}`))
	_, _ = s.Publish("staging", 1, []byte(`{"env":"staging"}`))

	production, _ := s.Current("production")
	staging, _ := s.Current("staging")

	if production.Version != 5 || staging.Version != 1 {
		t.Errorf("versions leaked across environments: prod=%d staging=%d",
			production.Version, staging.Version)
	}
}

func TestConcurrentPublishKeepsHighestVersion(t *testing.T) {
	s := New(nil, 64)

	var wg sync.WaitGroup
	for version := int64(1); version <= 200; version++ {
		wg.Add(1)
		go func(v int64) {
			defer wg.Done()
			// Most of these lose the race and are rejected as stale, which is
			// the correct outcome.
			_, _ = s.Publish("production", v, []byte(`{}`))
		}(version)
	}
	wg.Wait()

	current, err := s.Current("production")
	if err != nil {
		t.Fatalf("current: %v", err)
	}
	if current.Version != 200 {
		t.Errorf("version = %d, want 200 -- concurrent publishes must not lose the newest",
			current.Version)
	}
}
