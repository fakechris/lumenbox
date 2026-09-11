package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestServerHealth(t *testing.T) {
	store := NewEventStore(10, "")
	defer store.Close()

	srv := NewServer(store)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()

	srv.Routes().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var res map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res["status"] != "ok" {
		t.Fatalf("expected status ok, got %v", res["status"])
	}
}

func TestServerEventsGetAndPost(t *testing.T) {
	store := NewEventStore(10, "")
	defer store.Close()

	store.Append(Event{
		Type: TypeExec,
		Time: "2026-09-09T03:00:00Z",
		Detail: map[string]any{
			"cmd": "whoami",
		},
	})
	store.Append(Event{
		Type: TypeWindowFocus,
		Time: "2026-09-09T03:00:01Z",
		Window: "Terminal",
		Detail: map[string]any{"from": "Desktop"},
	})

	srv := NewServer(store)

	// GET with query
	getReq := httptest.NewRequest(http.MethodGet, "/events?since=1&limit=1", nil)
	getW := httptest.NewRecorder()
	srv.Routes().ServeHTTP(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", getW.Code)
	}

	var getRes EventsResult
	if err := json.Unmarshal(getW.Body.Bytes(), &getRes); err != nil {
		t.Fatal(err)
	}
	if len(getRes.Events) != 1 || getRes.Events[0].Seq != 2 {
		t.Fatalf("expected event seq 2, got %+v", getRes)
	}

	// POST with body
	postBody := `{"since": 0, "limit": 10}`
	postReq := httptest.NewRequest(http.MethodPost, "/events", strings.NewReader(postBody))
	postW := httptest.NewRecorder()
	srv.Routes().ServeHTTP(postW, postReq)

	if postW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", postW.Code)
	}

	var postRes EventsResult
	if err := json.Unmarshal(postW.Body.Bytes(), &postRes); err != nil {
		t.Fatal(err)
	}
	if len(postRes.Events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(postRes.Events))
	}

	// GET with tail
	tailReq := httptest.NewRequest(http.MethodGet, "/events?tail=1&limit=1", nil)
	tailW := httptest.NewRecorder()
	srv.Routes().ServeHTTP(tailW, tailReq)

	if tailW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", tailW.Code)
	}
	var tailRes EventsResult
	if err := json.Unmarshal(tailW.Body.Bytes(), &tailRes); err != nil {
		t.Fatal(err)
	}
	if len(tailRes.Events) != 1 || tailRes.Events[0].Seq != 2 {
		t.Fatalf("expected tail event seq 2, got %+v", tailRes)
	}

	// POST with tail
	postTailBody := `{"tail": true, "limit": 1}`
	postTailReq := httptest.NewRequest(http.MethodPost, "/events", strings.NewReader(postTailBody))
	postTailW := httptest.NewRecorder()
	srv.Routes().ServeHTTP(postTailW, postTailReq)

	if postTailW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", postTailW.Code)
	}
	var postTailRes EventsResult
	if err := json.Unmarshal(postTailW.Body.Bytes(), &postTailRes); err != nil {
		t.Fatal(err)
	}
	if len(postTailRes.Events) != 1 || postTailRes.Events[0].Seq != 2 {
		t.Fatalf("expected post tail event seq 2, got %+v", postTailRes)
	}
}
