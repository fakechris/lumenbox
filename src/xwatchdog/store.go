package main

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"sync"
)

const DefaultEventsMaxBytes = 32 * 1024 * 1024 // 32MB

func parseEventsMaxBytes() int64 {
	val := os.Getenv("AGENTBOX_AUDIT_EVENTS_MB")
	if val != "" {
		if mb, err := strconv.ParseInt(strings.TrimSpace(val), 10, 64); err == nil && mb > 0 {
			return mb * 1024 * 1024
		}
	}
	return DefaultEventsMaxBytes
}

// EventStore maintains in-memory ring buffer and appends to persistent storage.
type EventStore struct {
	mu         sync.RWMutex
	events     []Event
	maxSize    int
	currentSeq int64
	filePath   string
	fileHandle *os.File
	maxBytes   int64
	curBytes   int64
}

func NewEventStore(maxSize int, persistFilePath string) *EventStore {
	return NewEventStoreWithLimit(maxSize, persistFilePath, parseEventsMaxBytes())
}

func NewEventStoreWithLimit(maxSize int, persistFilePath string, maxBytes int64) *EventStore {
	if maxSize <= 0 {
		maxSize = 10000
	}
	if maxBytes <= 0 {
		maxBytes = DefaultEventsMaxBytes
	}

	var f *os.File
	var initialBytes int64 = 0
	if persistFilePath != "" {
		if fi, err := os.Stat(persistFilePath); err == nil {
			initialBytes = fi.Size()
		}
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
		maxBytes:   maxBytes,
		curBytes:   initialBytes,
	}
}

// CurBytes returns estimated bytes currently persisted on disk.
func (s *EventStore) CurBytes() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.curBytes
}

// MaxBytes returns configured maximum bytes for persistent file.
func (s *EventStore) MaxBytes() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.maxBytes
}

// SetMaxBytes overrides maxBytes dynamically (for testing).
func (s *EventStore) SetMaxBytes(b int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maxBytes = b
}

// compactLocked compacts persistent storage by writing the tail of in-memory ring events
// that fit within half the maxBytes ceiling, then reopening in append mode.
func (s *EventStore) compactLocked() {
	if s.filePath == "" {
		return
	}
	if s.fileHandle != nil {
		_ = s.fileHandle.Close()
		s.fileHandle = nil
	}

	targetBytes := s.maxBytes / 2
	if targetBytes < 1 {
		targetBytes = s.maxBytes
	}

	var toWrite [][]byte
	var accumulated int64 = 0
	for i := len(s.events) - 1; i >= 0; i-- {
		data, err := json.Marshal(s.events[i])
		if err != nil {
			continue
		}
		data = append(data, '\n')
		if accumulated+int64(len(data)) > targetBytes && len(toWrite) > 0 {
			break
		}
		toWrite = append(toWrite, data)
		accumulated += int64(len(data))
	}

	// Reverse to restore chronological order
	for i, j := 0, len(toWrite)-1; i < j; i, j = i+1, j-1 {
		toWrite[i], toWrite[j] = toWrite[j], toWrite[i]
	}

	tmpPath := s.filePath + ".compact"
	tmpFile, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
	if err != nil {
		// Fallback to direct rewrite
		f, errDirect := os.OpenFile(s.filePath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
		if errDirect != nil {
			return
		}
		var total int64
		for _, data := range toWrite {
			n, _ := f.Write(data)
			total += int64(n)
		}
		_ = f.Close()
		s.curBytes = total
		s.fileHandle, _ = os.OpenFile(s.filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		return
	}

	var total int64
	for _, data := range toWrite {
		n, _ := tmpFile.Write(data)
		total += int64(n)
	}
	_ = tmpFile.Close()

	if err := os.Rename(tmpPath, s.filePath); err != nil {
		_ = os.Remove(tmpPath)
		return
	}
	s.curBytes = total
	s.fileHandle, _ = os.OpenFile(s.filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
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

	if s.filePath != "" {
		data, err := json.Marshal(e)
		if err == nil {
			data = append(data, '\n')
			if s.maxBytes > 0 && (s.curBytes+int64(len(data)) > s.maxBytes) {
				s.compactLocked()
			} else if s.fileHandle != nil {
				n, writeErr := s.fileHandle.Write(data)
				if writeErr == nil {
					s.curBytes += int64(n)
				}
			}
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
