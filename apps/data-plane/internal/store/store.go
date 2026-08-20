// Package store holds the current ruleset snapshot per environment, plus a
// bounded history used to resume interrupted streams.
package store

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"

	"github.com/flagship/data-plane/internal/hub"
)

// ErrUnknownEnvironment is returned when no snapshot has been published yet.
var ErrUnknownEnvironment = errors.New("unknown environment")

// DefaultHistorySize bounds how many past versions are retained per
// environment. A client that reconnects within this window replays only what it
// missed; one that falls further behind is told to resync in full.
//
// The bound matters: retaining every version forever is a memory leak on a
// long-running process, and a client that has been gone for hours is better
// served by one current snapshot than by thousands of diffs.
const DefaultHistorySize = 64

// Snapshot is a versioned ruleset payload, already serialized.
type Snapshot struct {
	Environment string
	Version     int64
	// Payload is the serialized ruleset as clients receive it.
	Payload []byte
	// ETag identifies this exact payload for HTTP conditional requests.
	ETag string
}

type environmentState struct {
	current Snapshot
	// history is a ring of recent snapshots, oldest first.
	history []Snapshot
}

// Store is safe for concurrent use.
type Store struct {
	mu           sync.RWMutex
	environments map[string]*environmentState
	historySize  int
	hub          *hub.Hub
}

// New creates a Store. A nil hub disables broadcasting, which is useful in tests.
func New(h *hub.Hub, historySize int) *Store {
	if historySize <= 0 {
		historySize = DefaultHistorySize
	}
	return &Store{
		environments: make(map[string]*environmentState),
		historySize:  historySize,
		hub:          h,
	}
}

// ComputeETag derives a strong ETag from the payload.
func ComputeETag(payload []byte) string {
	sum := sha256.Sum256(payload)
	return `"` + hex.EncodeToString(sum[:16]) + `"`
}

// Publish stores a new snapshot and broadcasts it to subscribers.
//
// Versions must increase. A stale or replayed publish is rejected rather than
// applied, so an out-of-order delivery from the control plane cannot roll an
// environment backwards.
func (s *Store) Publish(environment string, version int64, payload []byte) (Snapshot, error) {
	if version <= 0 {
		return Snapshot{}, errors.New("version must be positive")
	}

	snapshot := Snapshot{
		Environment: environment,
		Version:     version,
		Payload:     payload,
		ETag:        ComputeETag(payload),
	}

	s.mu.Lock()
	state, ok := s.environments[environment]
	if !ok {
		state = &environmentState{}
		s.environments[environment] = state
	}
	if state.current.Version >= version {
		current := state.current
		s.mu.Unlock()
		return current, ErrStaleVersion
	}

	state.current = snapshot
	state.history = append(state.history, snapshot)
	if len(state.history) > s.historySize {
		// Drop the oldest. Copying keeps the backing array from growing without
		// bound as the slice header advances.
		state.history = append(state.history[:0], state.history[1:]...)
	}
	s.mu.Unlock()

	if s.hub != nil {
		s.hub.Broadcast(environment, hub.Message{
			ID:      formatVersion(version),
			Event:   "ruleset",
			Data:    payload,
			Version: version,
		})
	}

	return snapshot, nil
}

// ErrStaleVersion indicates a publish was rejected for not advancing the version.
var ErrStaleVersion = errors.New("version did not advance")

// Current returns the latest snapshot for an environment.
func (s *Store) Current(environment string) (Snapshot, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	state, ok := s.environments[environment]
	if !ok || state.current.Version == 0 {
		return Snapshot{}, ErrUnknownEnvironment
	}
	return state.current, nil
}

// Resume returns the snapshots a client missed since afterVersion.
//
// needsFullResync is true when the client has fallen outside the retained
// history and must fetch a complete snapshot instead of replaying diffs.
func (s *Store) Resume(environment string, afterVersion int64) (missed []Snapshot, needsFullResync bool, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	state, ok := s.environments[environment]
	if !ok || state.current.Version == 0 {
		return nil, false, ErrUnknownEnvironment
	}

	// Already current.
	if afterVersion >= state.current.Version {
		return nil, false, nil
	}

	// A client from the future, or one citing a version we never had, cannot be
	// reconciled by replay.
	if len(state.history) == 0 {
		return nil, true, nil
	}

	oldest := state.history[0].Version
	if afterVersion < oldest-1 {
		// The gap predates our history.
		return nil, true, nil
	}

	for _, snapshot := range state.history {
		if snapshot.Version > afterVersion {
			missed = append(missed, snapshot)
		}
	}
	return missed, false, nil
}

// Environments lists the environments with a published snapshot.
func (s *Store) Environments() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	names := make([]string, 0, len(s.environments))
	for name := range s.environments {
		names = append(names, name)
	}
	return names
}

func formatVersion(version int64) string {
	// SSE ids are opaque strings; the version is what a client echoes back.
	const digits = "0123456789"
	if version == 0 {
		return "0"
	}
	var buffer [20]byte
	position := len(buffer)
	for version > 0 {
		position--
		buffer[position] = digits[version%10]
		version /= 10
	}
	return string(buffer[position:])
}
