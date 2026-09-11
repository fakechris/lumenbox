package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

type Server struct {
	store     *EventStore
	startedAt time.Time
}

func NewServer(store *EventStore) *Server {
	return &Server{
		store:     store,
		startedAt: time.Now(),
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/events", s.handleEvents)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":   "ok",
		"uptime_s": int(time.Since(s.startedAt).Seconds()),
	})
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var since int64 = 0
	limit := 100
	tail := false

	if r.Method == http.MethodGet {
		if sStr := r.URL.Query().Get("since"); sStr != "" {
			if n, err := strconv.ParseInt(sStr, 10, 64); err == nil && n >= 0 {
				since = n
			}
		}
		if lStr := r.URL.Query().Get("limit"); lStr != "" {
			if n, err := strconv.Atoi(lStr); err == nil && n > 0 {
				limit = n
			}
		}
		if tStr := r.URL.Query().Get("tail"); tStr == "1" || tStr == "true" {
			tail = true
		}
	} else if r.Method == http.MethodPost {
		var body struct {
			Since *int64 `json:"since"`
			Limit *int   `json:"limit"`
			Tail  *bool  `json:"tail"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
			if body.Since != nil && *body.Since >= 0 {
				since = *body.Since
			}
			if body.Limit != nil && *body.Limit > 0 {
				limit = *body.Limit
			}
			if body.Tail != nil {
				tail = *body.Tail
			}
		}
	}

	var res EventsResult
	if tail {
		res = s.store.QueryTail(limit)
	} else {
		res = s.store.Query(since, limit)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(res)
}
