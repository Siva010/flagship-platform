package api

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/flagship/data-plane/internal/hub"
	"github.com/flagship/data-plane/internal/store"
)

func newTestServer(t *testing.T) (*httptest.Server, *store.Store, *hub.Hub) {
	t.Helper()

	h := hub.New(hub.Options{Shards: 4, BufferSize: 8})
	st := store.New(h, 8)
	server := NewServer(Options{Hub: h, Store: st, KeepAlive: 50 * time.Millisecond})

	httpServer := httptest.NewServer(server.Routes())
	t.Cleanup(func() {
		httpServer.Close()
		h.CloseAll()
	})
	return httpServer, st, h
}

func TestSnapshotReturnsPayloadAndETag(t *testing.T) {
	server, st, _ := newTestServer(t)

	payload := []byte(`{"version":1,"flags":[]}`)
	if _, err := st.Publish("production", 1, payload); err != nil {
		t.Fatalf("publish: %v", err)
	}

	response, err := http.Get(server.URL + "/v1/snapshot?env=production")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	etag := response.Header.Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag")
	}
	if got := response.Header.Get("X-Flagship-Version"); got != "1" {
		t.Errorf("version header = %q, want 1", got)
	}

	body, _ := io.ReadAll(response.Body)
	if string(body) != string(payload) {
		t.Errorf("body = %q, want %q", body, payload)
	}
}

// TestSnapshotConditionalGet covers the polling fallback: an unchanged ruleset
// must cost headers, not payload.
func TestSnapshotConditionalGet(t *testing.T) {
	server, st, _ := newTestServer(t)
	if _, err := st.Publish("production", 1, []byte(`{"v":1}`)); err != nil {
		t.Fatalf("publish: %v", err)
	}

	first, err := http.Get(server.URL + "/v1/snapshot?env=production")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	first.Body.Close()
	etag := first.Header.Get("ETag")

	request, _ := http.NewRequest(http.MethodGet, server.URL+"/v1/snapshot?env=production", nil)
	request.Header.Set("If-None-Match", etag)

	second, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("conditional get: %v", err)
	}
	defer second.Body.Close()

	if second.StatusCode != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", second.StatusCode)
	}
	body, _ := io.ReadAll(second.Body)
	if len(body) != 0 {
		t.Errorf("304 must have an empty body, got %d bytes", len(body))
	}

	// After a new publish the ETag must change and the same request get a 200.
	if _, err := st.Publish("production", 2, []byte(`{"v":2}`)); err != nil {
		t.Fatalf("publish: %v", err)
	}
	third, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("post-publish get: %v", err)
	}
	defer third.Body.Close()
	if third.StatusCode != http.StatusOK {
		t.Errorf("status = %d after publish, want 200", third.StatusCode)
	}
}

func TestSnapshotUnknownEnvironment(t *testing.T) {
	server, _, _ := newTestServer(t)

	response, err := http.Get(server.URL + "/v1/snapshot?env=nope")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", response.StatusCode)
	}
}

// readFrames reads SSE frames until the context is done or count frames arrive.
func readFrames(t *testing.T, body io.Reader, count int, timeout time.Duration) []string {
	t.Helper()

	frames := make([]string, 0, count)
	done := make(chan struct{})

	go func() {
		defer close(done)
		scanner := bufio.NewScanner(body)
		var current strings.Builder
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				if current.Len() > 0 {
					frames = append(frames, current.String())
					current.Reset()
					if len(frames) >= count {
						return
					}
				}
				continue
			}
			if strings.HasPrefix(line, ":") {
				continue // keep-alive comment
			}
			current.WriteString(line)
			current.WriteString("\n")
		}
	}()

	select {
	case <-done:
	case <-time.After(timeout):
	}
	return frames
}

func TestStreamSendsCurrentSnapshotOnConnect(t *testing.T) {
	server, st, _ := newTestServer(t)
	if _, err := st.Publish("production", 7, []byte(`{"v":7}`)); err != nil {
		t.Fatalf("publish: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/v1/stream?env=production", nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	defer response.Body.Close()

	if contentType := response.Header.Get("Content-Type"); contentType != "text/event-stream" {
		t.Errorf("content-type = %q", contentType)
	}

	frames := readFrames(t, response.Body, 1, 2*time.Second)
	if len(frames) != 1 {
		t.Fatalf("got %d frames, want 1", len(frames))
	}
	if !strings.Contains(frames[0], "id: 7") {
		t.Errorf("frame missing id: %q", frames[0])
	}
	if !strings.Contains(frames[0], `data: {"v":7}`) {
		t.Errorf("frame missing payload: %q", frames[0])
	}
}

func TestStreamDeliversLivePublishes(t *testing.T) {
	server, st, _ := newTestServer(t)
	if _, err := st.Publish("production", 1, []byte(`{"v":1}`)); err != nil {
		t.Fatalf("publish: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/v1/stream?env=production", nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	defer response.Body.Close()

	collected := make(chan []string, 1)
	go func() { collected <- readFrames(t, response.Body, 3, 3*time.Second) }()

	// Let the initial snapshot land, then publish more.
	time.Sleep(100 * time.Millisecond)
	if _, err := st.Publish("production", 2, []byte(`{"v":2}`)); err != nil {
		t.Fatalf("publish 2: %v", err)
	}
	if _, err := st.Publish("production", 3, []byte(`{"v":3}`)); err != nil {
		t.Fatalf("publish 3: %v", err)
	}

	frames := <-collected
	if len(frames) < 3 {
		t.Fatalf("got %d frames, want 3: %v", len(frames), frames)
	}
	for i, want := range []string{"id: 1", "id: 2", "id: 3"} {
		if !strings.Contains(frames[i], want) {
			t.Errorf("frame %d = %q, want %s", i, frames[i], want)
		}
	}
}

// TestStreamResumesFromLastEventID is the reconnection path: a client that
// dropped at version 1 must receive 2 and 3, not a duplicate of 1.
func TestStreamResumesFromLastEventID(t *testing.T) {
	server, st, _ := newTestServer(t)
	for version := int64(1); version <= 3; version++ {
		if _, err := st.Publish("production", version, []byte(`{"v":`+string(rune('0'+version))+`}`)); err != nil {
			t.Fatalf("publish %d: %v", version, err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/v1/stream?env=production", nil)
	request.Header.Set("Last-Event-ID", "1")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	defer response.Body.Close()

	frames := readFrames(t, response.Body, 2, 2*time.Second)
	if len(frames) != 2 {
		t.Fatalf("got %d frames, want 2 (versions 2 and 3): %v", len(frames), frames)
	}
	if !strings.Contains(frames[0], "id: 2") {
		t.Errorf("first replayed frame = %q, want id: 2", frames[0])
	}
	if !strings.Contains(frames[1], "id: 3") {
		t.Errorf("second replayed frame = %q, want id: 3", frames[1])
	}
}

// TestStreamFullResyncWhenTooFarBehind covers a client outside the retained
// history: it must get one current snapshot, not a partial replay that would
// leave it with a gap.
func TestStreamFullResyncWhenTooFarBehind(t *testing.T) {
	h := hub.New(hub.Options{Shards: 2, BufferSize: 8})
	st := store.New(h, 3) // tiny history
	server := NewServer(Options{Hub: h, Store: st, KeepAlive: time.Second})
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	defer h.CloseAll()

	for version := int64(1); version <= 10; version++ {
		if _, err := st.Publish("production", version, []byte(`{}`)); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, httpServer.URL+"/v1/stream?env=production", nil)
	request.Header.Set("Last-Event-ID", "1") // long gone from a 3-entry history

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	defer response.Body.Close()

	frames := readFrames(t, response.Body, 1, 2*time.Second)
	if len(frames) != 1 {
		t.Fatalf("got %d frames, want exactly 1 full resync: %v", len(frames), frames)
	}
	if !strings.Contains(frames[0], "id: 10") {
		t.Errorf("resync frame = %q, want current version 10", frames[0])
	}
}

func TestStreamRequiresEnvironment(t *testing.T) {
	server, _, _ := newTestServer(t)

	response, err := http.Get(server.URL + "/v1/stream")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", response.StatusCode)
	}
}

func TestStreamUnsubscribesOnClientDisconnect(t *testing.T) {
	server, st, h := newTestServer(t)
	if _, err := st.Publish("production", 1, []byte(`{}`)); err != nil {
		t.Fatalf("publish: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/v1/stream?env=production", nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}

	// Wait for the subscription to register.
	deadline := time.Now().Add(2 * time.Second)
	for h.Stats().Connected == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if h.Stats().Connected != 1 {
		t.Fatalf("connected = %d, want 1", h.Stats().Connected)
	}

	cancel()
	response.Body.Close()

	// The handler must unregister, or connections leak for the process lifetime.
	deadline = time.Now().Add(2 * time.Second)
	for h.Stats().Connected != 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if connected := h.Stats().Connected; connected != 0 {
		t.Errorf("connected = %d after disconnect, want 0", connected)
	}
}

// --- Publish authentication ---------------------------------------------

func newPublishServer(t *testing.T, token string) *httptest.Server {
	t.Helper()

	h := hub.New(hub.Options{Shards: 2, BufferSize: 8})
	st := store.New(h, 8)
	server := NewServer(Options{Hub: h, Store: st, PublishToken: token, KeepAlive: time.Second})

	httpServer := httptest.NewServer(server.Routes())
	t.Cleanup(func() {
		httpServer.Close()
		h.CloseAll()
	})
	return httpServer
}

func postPublish(t *testing.T, server *httptest.Server, token string) *http.Response {
	t.Helper()

	body := strings.NewReader(`{"environment":"production","version":1,"payload":{"flags":[]}}`)
	request, err := http.NewRequest(http.MethodPost, server.URL+"/internal/v1/publish", body)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	return response
}

// TestPublishDisabledWithoutToken is the fail-closed case. A missing
// environment variable must disable the endpoint, never leave it open --
// anyone who can publish controls what every connected SDK evaluates.
func TestPublishDisabledWithoutToken(t *testing.T) {
	server := newPublishServer(t, "")

	response := postPublish(t, server, "")
	defer response.Body.Close()

	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when no token is configured", response.StatusCode)
	}
}

// A token presented against a server with none configured must still fail:
// "no token configured" cannot be satisfied by guessing.
func TestPublishDisabledIgnoresPresentedToken(t *testing.T) {
	server := newPublishServer(t, "")

	response := postPublish(t, server, "anything")
	defer response.Body.Close()

	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.StatusCode)
	}
}

func TestPublishRequiresBearerToken(t *testing.T) {
	server := newPublishServer(t, "secret-token")

	response := postPublish(t, server, "")
	defer response.Body.Close()

	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 without a token", response.StatusCode)
	}
}

func TestPublishRejectsWrongToken(t *testing.T) {
	server := newPublishServer(t, "secret-token")

	for _, wrong := range []string{"wrong", "secret-toke", "secret-tokenX", ""} {
		response := postPublish(t, server, wrong)
		response.Body.Close()
		if wrong == "" {
			continue // covered above
		}
		if response.StatusCode != http.StatusUnauthorized {
			t.Errorf("token %q: status = %d, want 401", wrong, response.StatusCode)
		}
	}
}

func TestPublishAcceptsCorrectToken(t *testing.T) {
	server := newPublishServer(t, "secret-token")

	response := postPublish(t, server, "secret-token")
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("status = %d, want 200; body=%s", response.StatusCode, body)
	}
}

// An authenticated publish must still reach subscribers, so authentication was
// added in front of the path rather than across it.
func TestAuthenticatedPublishStillBroadcasts(t *testing.T) {
	h := hub.New(hub.Options{Shards: 2, BufferSize: 8})
	st := store.New(h, 8)
	server := NewServer(Options{Hub: h, Store: st, PublishToken: "secret-token"})
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	defer h.CloseAll()

	subscriber := h.Subscribe("sub", "production")

	response := postPublish(t, httpServer, "secret-token")
	response.Body.Close()

	select {
	case message := <-subscriber.Messages():
		if message.Version != 1 {
			t.Errorf("version = %d, want 1", message.Version)
		}
	case <-time.After(time.Second):
		t.Fatal("subscriber received nothing after an authorized publish")
	}
}
