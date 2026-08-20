// Package api serves ruleset snapshots over HTTP and SSE.
package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/flagship/data-plane/internal/hub"
	"github.com/flagship/data-plane/internal/store"
)

// Server wires the hub and store to HTTP handlers.
type Server struct {
	hub    *hub.Hub
	store  *store.Store
	logger *slog.Logger

	// keepAlive bounds how long a stream may sit silent. Proxies and load
	// balancers close idle connections; a periodic comment frame keeps them open
	// without the client having to reconnect.
	keepAlive time.Duration

	nextSubscriberID func() string
}

// Options configures a Server.
type Options struct {
	Hub       *hub.Hub
	Store     *store.Store
	Logger    *slog.Logger
	KeepAlive time.Duration
}

// NewServer creates a Server.
func NewServer(options Options) *Server {
	keepAlive := options.KeepAlive
	if keepAlive <= 0 {
		keepAlive = 25 * time.Second
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}

	var counter uint64
	return &Server{
		hub:       options.Hub,
		store:     options.Store,
		logger:    logger,
		keepAlive: keepAlive,
		nextSubscriberID: func() string {
			counter++
			return fmt.Sprintf("sub-%d-%d", time.Now().UnixNano(), counter)
		},
	}
}

// Routes returns the HTTP handler.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /v1/snapshot", s.handleSnapshot)
	mux.HandleFunc("GET /v1/stream", s.handleStream)
	mux.HandleFunc("GET /v1/stats", s.handleStats)
	mux.HandleFunc("POST /internal/v1/publish", s.handlePublish)
	return mux
}

// PublishRequest is the control plane's ingress for a new ruleset version.
type PublishRequest struct {
	Environment string          `json:"environment"`
	Version     int64           `json:"version"`
	Payload     json.RawMessage `json:"payload"`
}

// handlePublish accepts a new ruleset from the control plane.
//
// This path is internal: it must never be reachable from the public internet,
// since anyone who can call it can change what every SDK evaluates. The spec
// puts gRPC between the planes; this HTTP endpoint is the interim shape and
// still needs network-level isolation plus service authentication before it is
// exposed anywhere real.
func (s *Server) handlePublish(w http.ResponseWriter, r *http.Request) {
	var request PublishRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if request.Environment == "" {
		writeError(w, http.StatusBadRequest, "missing environment")
		return
	}
	if request.Version <= 0 {
		writeError(w, http.StatusBadRequest, "version must be positive")
		return
	}
	if len(request.Payload) == 0 {
		writeError(w, http.StatusBadRequest, "missing payload")
		return
	}

	snapshot, err := s.store.Publish(request.Environment, request.Version, request.Payload)
	if err != nil {
		if errors.Is(err, store.ErrStaleVersion) {
			// Not an error the caller should retry: a newer version already won.
			// 409 says so precisely.
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":          "version did not advance",
				"currentVersion": snapshot.Version,
			})
			return
		}
		writeError(w, http.StatusInternalServerError, "publish failed")
		return
	}

	s.logger.Info("published ruleset",
		"environment", request.Environment, "version", request.Version,
		"connected", s.hub.Stats().Connected)

	writeJSON(w, http.StatusOK, map[string]any{
		"environment": snapshot.Environment,
		"version":     snapshot.Version,
		"etag":        snapshot.ETag,
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleStats(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.hub.Stats())
}

// handleSnapshot serves the current ruleset with ETag-based conditional GET.
//
// This is the polling fallback for clients that cannot hold an SSE connection,
// and the cold-start path for those that can. A matching If-None-Match returns
// 304 with no body, so an unchanged ruleset costs headers rather than payload.
func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	environment := r.URL.Query().Get("env")
	if environment == "" {
		writeError(w, http.StatusBadRequest, "missing env parameter")
		return
	}

	snapshot, err := s.store.Current(environment)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown environment")
		return
	}

	w.Header().Set("ETag", snapshot.ETag)
	w.Header().Set("X-Flagship-Version", strconv.FormatInt(snapshot.Version, 10))
	// Snapshots are immutable per version, but the URL is not versioned, so the
	// client must revalidate rather than serve a cached copy blindly.
	w.Header().Set("Cache-Control", "no-cache, must-revalidate")

	if match := r.Header.Get("If-None-Match"); match != "" && match == snapshot.ETag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(snapshot.Payload)
}

// handleStream serves the SSE ruleset channel.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	environment := r.URL.Query().Get("env")
	if environment == "" {
		writeError(w, http.StatusBadRequest, "missing env parameter")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Defeats proxy buffering, which would otherwise hold events until the
	// buffer fills -- fatal for a channel whose whole point is low latency.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// Subscribe before replaying history, so an update landing mid-replay is
	// queued rather than lost. The client's monotonic version guard makes a
	// duplicate harmless; a gap would not be.
	subscriber := s.hub.Subscribe(s.nextSubscriberID(), environment)
	defer s.hub.Unsubscribe(subscriber)

	if !s.replayOrResync(w, flusher, r, environment) {
		return
	}

	keepAlive := time.NewTicker(s.keepAlive)
	defer keepAlive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return

		case <-subscriber.Done():
			// Evicted. Tell the client why, if the connection still accepts a
			// write, so it reconnects and resyncs rather than assuming it is
			// current.
			if subscriber.DropReason() == hub.DropSlowConsumer {
				s.logger.Warn("evicting slow consumer",
					"subscriber", subscriber.ID(), "environment", environment)
				writeEvent(w, "", "resync", []byte(`{"reason":"slow_consumer"}`))
				flusher.Flush()
			}
			return

		case message := <-subscriber.Messages():
			writeEvent(w, message.ID, message.Event, message.Data)
			flusher.Flush()

		case <-keepAlive.C:
			// A comment frame: ignored by the client, but enough traffic to stop
			// an intermediary reaping the connection.
			_, _ = fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}

// replayOrResync brings a reconnecting client up to date. Returns false if the
// connection should close.
func (s *Server) replayOrResync(
	w http.ResponseWriter,
	flusher http.Flusher,
	r *http.Request,
	environment string,
) bool {
	lastEventID := r.Header.Get("Last-Event-ID")
	if lastEventID == "" {
		// Also accept it as a query parameter: EventSource cannot set headers on
		// the initial request, only on its own reconnects.
		lastEventID = r.URL.Query().Get("lastEventId")
	}

	var afterVersion int64
	if lastEventID != "" {
		parsed, err := strconv.ParseInt(lastEventID, 10, 64)
		if err != nil {
			// A malformed id is treated as a cold start rather than an error:
			// the client gets a full snapshot and converges.
			afterVersion = 0
		} else {
			afterVersion = parsed
		}
	}

	if afterVersion <= 0 {
		snapshot, err := s.store.Current(environment)
		if err != nil {
			// No ruleset yet. Hold the connection open: one may be published
			// while this client is connected.
			return true
		}
		writeEvent(w, strconv.FormatInt(snapshot.Version, 10), "ruleset", snapshot.Payload)
		flusher.Flush()
		return true
	}

	missed, needsFullResync, err := s.store.Resume(environment, afterVersion)
	if err != nil {
		return true
	}

	if needsFullResync {
		snapshot, currentErr := s.store.Current(environment)
		if currentErr != nil {
			return true
		}
		s.logger.Info("client fell outside history, sending full snapshot",
			"environment", environment, "clientVersion", afterVersion,
			"currentVersion", snapshot.Version)
		writeEvent(w, strconv.FormatInt(snapshot.Version, 10), "ruleset", snapshot.Payload)
		flusher.Flush()
		return true
	}

	for _, snapshot := range missed {
		writeEvent(w, strconv.FormatInt(snapshot.Version, 10), "ruleset", snapshot.Payload)
	}
	if len(missed) > 0 {
		flusher.Flush()
	}
	return true
}

// writeEvent emits one SSE frame.
func writeEvent(w http.ResponseWriter, id, event string, data []byte) {
	if id != "" {
		_, _ = fmt.Fprintf(w, "id: %s\n", id)
	}
	if event != "" {
		_, _ = fmt.Fprintf(w, "event: %s\n", event)
	}
	// SSE is line-oriented: a payload containing a newline must be split across
	// multiple data: lines, or everything after the first newline is parsed as a
	// new frame. Compact JSON has no literal newlines, but relying on that makes
	// the framing depend on the serializer's settings.
	for _, line := range bytes.Split(data, []byte("\n")) {
		_, _ = fmt.Fprintf(w, "data: %s\n", line)
	}
	_, _ = fmt.Fprint(w, "\n")
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
