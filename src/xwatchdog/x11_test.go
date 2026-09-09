package main

import (
	"testing"
)

func TestWindowFocusRecordsChangesNotContent(t *testing.T) {
	store := NewEventStore(100, "")
	focus := NewWindowFocus(1, store)

	// The first window is a baseline, not an event.
	focus.SetWindow("Terminal")
	// Same window again: nothing.
	focus.SetWindow("Terminal")
	// A change: one window_focus event.
	focus.SetWindow("Firefox")

	events := store.Snapshot()
	if len(events) != 1 {
		t.Fatalf("expected exactly one focus event, got %d", len(events))
	}
	if events[0].Type != TypeWindowFocus {
		t.Fatalf("expected window_focus, got %s", events[0].Type)
	}
	if events[0].Window != "Firefox" {
		t.Fatalf("expected Firefox, got %q", events[0].Window)
	}
	// The audit records the window, never typed content: there is no text field to leak.
	if _, ok := events[0].Detail["text"]; ok {
		t.Fatal("a window_focus event must not carry typed text")
	}
}
