package main

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// WindowFocus tracks which window is focused, and records a window_focus event on change.
//
// This is the whole of the GUI audit: which application/window a person had in front of them,
// when. It records the window *title* the desktop already shows on screen — not what was typed
// into it, not mouse coordinates, not keystrokes. Recording input content would make this a
// keylogger; a jump box audits actions, and the actions here are "opened this window" and (via
// Snoopy) "ran this command".
type WindowFocus struct {
	current string
	display int
	store   *EventStore
}

func NewWindowFocus(display int, store *EventStore) *WindowFocus {
	return &WindowFocus{display: display, store: store}
}

// SetWindow records a window_focus event when the focused window changes.
func (w *WindowFocus) SetWindow(title string) {
	if title == w.current {
		return
	}
	// The first observation sets a baseline without an event: there is no "change" to report yet.
	if w.current != "" {
		w.store.Append(Event{
			Type:    TypeWindowFocus,
			Time:    time.Now().UTC().Format(time.RFC3339),
			Display: w.display,
			Window:  title,
			Detail:  map[string]any{"from": w.current},
		})
	}
	w.current = title
}

// GetActiveWindowName reads the active window title using xdotool.
func GetActiveWindowName(displayStr string) string {
	cmd := exec.Command("xdotool", "getactivewindow", "getwindowname")
	if displayStr != "" {
		cmd.Env = append(cmd.Environ(), "DISPLAY="+displayStr)
	}
	out, err := cmd.Output()
	if err != nil {
		return "Desktop"
	}
	res := strings.TrimSpace(string(out))
	if res == "" {
		return "Desktop"
	}
	return res
}

// MonitorX11 polls the active window and records focus changes.
func MonitorX11(ctx context.Context, displayStr string, displayNum int, focus *WindowFocus, pollInterval time.Duration) {
	if pollInterval <= 0 {
		pollInterval = 500 * time.Millisecond
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			focus.SetWindow(GetActiveWindowName(displayStr))
		}
	}
}
