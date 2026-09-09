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
}
