package main

import (
	"encoding/json"
	"os"
	"sync"
)

// EventStore maintains in-memory ring buffer and appends to persistent storage.
type EventStore struct {
	mu         sync.RWMutex
	events     []Event
	maxSize    int
	currentSeq int64
	filePath   string
	fileHandle *os.File
}

func NewEventStore(maxSize int, persistFilePath string) *EventStore {
	if maxSize <= 0 {
		maxSize = 10000
	}

	var f *os.File
	if persistFilePath != "" {
		file, err := os.OpenFile(persistFilePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err == nil {
			f = file
		}
	}

	return &EventStore{
		events:     make([]Event, 0, 1024),
		maxSize:    maxSize,
		filePath:   persistFilePath,
		fileHandle: f,
	}
}

// Append assigns a monotonic sequence number, stores in memory, and persists to disk.
func (s *EventStore) Append(e Event) Event {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.currentSeq++
	e.Seq = s.currentSeq

	if len(s.events) >= s.maxSize {
		// Evict oldest 20%
		evict := s.maxSize / 5
		if evict < 1 {
			evict = 1
		}
		s.events = s.events[evict:]
	}
	s.events = append(s.events, e)

	if s.fileHandle != nil {
		if data, err := json.Marshal(e); err == nil {
			data = append(data, '\n')
			_, _ = s.fileHandle.Write(data)
		}
	}

	return e
}

// Query fetches events strictly after sinceSeq up to limit items.
func (s *EventStore) Query(sinceSeq int64, limit int) EventsResult {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}

	var matched []Event
	// Binary search or linear scan from end/start
	for _, ev := range s.events {
		if ev.Seq > sinceSeq {
			matched = append(matched, ev)
		}
	}

	hasMore := len(matched) > limit
	if hasMore {
		matched = matched[:limit]
	}

	nextSeq := sinceSeq
	if len(matched) > 0 {
		nextSeq = matched[len(matched)-1].Seq
	}

	return EventsResult{
		Events:  matched,
		NextSeq: nextSeq,
		HasMore: hasMore,
	}
}

// QueryTail returns up to limit most recent events in memory.
func (s *EventStore) QueryTail(limit int) EventsResult {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}

	n := len(s.events)
	if n == 0 {
		return EventsResult{
			Events:  []Event{},
			NextSeq: s.currentSeq,
			HasMore: false,
		}
	}

	start := n - limit
	if start < 0 {
		start = 0
	}
	slice := s.events[start:]
	matched := make([]Event, len(slice))
	copy(matched, slice)

	return EventsResult{
		Events:  matched,
		NextSeq: s.currentSeq,
		HasMore: false,
	}
}

// Close closes any underlying file handles.
// Snapshot returns a copy of the buffered events, for tests and health checks.
func (s *EventStore) Snapshot() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Event, len(s.events))
	copy(out, s.events)
	return out
}

func (s *EventStore) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fileHandle != nil {
		_ = s.fileHandle.Close()
		s.fileHandle = nil
	}
}
