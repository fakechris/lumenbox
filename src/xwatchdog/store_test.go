package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEventStore(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "xwatchdog-store-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	persistPath := filepath.Join(tmpDir, "events.jsonl")
	store := NewEventStore(10, persistPath)
	defer store.Close()

	// Append 5 events
	for i := 1; i <= 5; i++ {
		store.Append(Event{
			Type: TypeExec,
			Time: "2026-09-09T03:00:00Z",
			Detail: map[string]any{
				"cmd": "test",
			},
		})
	}

	// Query all
	res := store.Query(0, 10)
	if len(res.Events) != 5 {
		t.Fatalf("expected 5 events, got %d", len(res.Events))
	}
	if res.NextSeq != 5 {
		t.Fatalf("expected next_seq 5, got %d", res.NextSeq)
	}
	if res.HasMore {
		t.Fatalf("expected has_more false")
	}

	// Query pagination (since 2, limit 2)
	paged := store.Query(2, 2)
	if len(paged.Events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(paged.Events))
	}
	if paged.Events[0].Seq != 3 || paged.Events[1].Seq != 4 {
		t.Fatalf("expected seq 3 and 4, got %d and %d", paged.Events[0].Seq, paged.Events[1].Seq)
	}
	if paged.NextSeq != 4 {
		t.Fatalf("expected next_seq 4, got %d", paged.NextSeq)
	}
	if !paged.HasMore {
		t.Fatalf("expected has_more true")
	}

	// Query tail
	tailRes := store.QueryTail(3)
	if len(tailRes.Events) != 3 {
		t.Fatalf("expected 3 tail events, got %d", len(tailRes.Events))
	}
	if tailRes.Events[0].Seq != 3 || tailRes.Events[1].Seq != 4 || tailRes.Events[2].Seq != 5 {
		t.Fatalf("expected tail events seq 3, 4, 5, got %d, %d, %d", tailRes.Events[0].Seq, tailRes.Events[1].Seq, tailRes.Events[2].Seq)
	}
	if tailRes.NextSeq != 5 {
		t.Fatalf("expected tail next_seq 5, got %d", tailRes.NextSeq)
	}
	if tailRes.HasMore {
		t.Fatalf("expected tail has_more false")
	}
}

func TestEventStoreDiskCeiling(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "xwatchdog-store-ceiling-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	persistPath := filepath.Join(tmpDir, "events.jsonl")
	// Set a tight disk ceiling of 16KB
	const maxBytes = 16 * 1024
	store := NewEventStoreWithLimit(500, persistPath, maxBytes)
	defer store.Close()

	// Append 2000 events (well above 16KB, typically ~300KB)
	for i := 1; i <= 2000; i++ {
		store.Append(Event{
			Type: TypeExec,
			Time: "2026-09-09T03:00:00Z",
			Detail: map[string]any{
				"cmd":  "test-command-arg1-arg2-arg3-long-enough",
				"iter": i,
			},
		})
	}

	fi, err := os.Stat(persistPath)
	if err != nil {
		t.Fatalf("stat failed: %v", err)
	}

	if fi.Size() > maxBytes {
		t.Fatalf("file size %d exceeded ceiling %d", fi.Size(), maxBytes)
	}
	if fi.Size() == 0 {
		t.Fatalf("file size is 0, expected populated file")
	}
}

func TestEventStoreSeedsFromExistingFile(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "xwatchdog-store-seed-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	persistPath := filepath.Join(tmpDir, "events.jsonl")
	// Pre-seed a 1MB file
	f, err := os.Create(persistPath)
	if err != nil {
		t.Fatal(err)
	}
	chunk := []byte("{\"type\":\"exec\",\"time\":\"2026-09-09T03:00:00Z\",\"detail\":{\"cmd\":\"old-seed-data\"}}\n")
	for i := 0; i < 1024*1024/len(chunk); i++ {
		_, _ = f.Write(chunk)
	}
	_ = f.Close()

	fiBefore, err := os.Stat(persistPath)
	if err != nil {
		t.Fatal(err)
	}
	if fiBefore.Size() < 500*1024 {
		t.Fatalf("expected seeded file >= 500KB, got %d", fiBefore.Size())
	}

	// Create store with 64KB limit pointing to pre-seeded 1MB file
	const maxBytes = 64 * 1024
	store := NewEventStoreWithLimit(100, persistPath, maxBytes)
	defer store.Close()

	// On the very first append, the store must detect size > maxBytes and compact immediately
	store.Append(Event{
		Type: TypeExec,
		Time: "2026-09-09T03:00:01Z",
		Detail: map[string]any{
			"cmd": "first-append-after-reboot",
		},
	})

	fiAfter, err := os.Stat(persistPath)
	if err != nil {
		t.Fatal(err)
	}

	if fiAfter.Size() > maxBytes {
		t.Fatalf("expected compacted file <= %d, got %d", maxBytes, fiAfter.Size())
	}
	if fiAfter.Size() >= fiBefore.Size() {
		t.Fatalf("expected file to shrink from %d, got %d", fiBefore.Size(), fiAfter.Size())
	}
}
