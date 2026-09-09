package main

// EventType represents the category of the audit event.
//
// A company operations jump box audits *actions*, not *content*: the commands a person ran, the
// window they had focused, and the daemon's own lifecycle. It deliberately does not record what
// was typed into any window — a bastion records commands and session activity, not keystroke
// content, and never credentials. Disclosed to the person on entry (see docker/box MOTD).
type EventType string

const (
	TypeExec        EventType = "exec"
	TypeWindowFocus EventType = "window_focus"
	TypeSystem      EventType = "system"
)

// Event is the standardized audit event structure.
type Event struct {
	Seq     int64          `json:"seq"`
	Type    EventType      `json:"type"`
	Time    string         `json:"time"`
	Display int            `json:"display,omitempty"`
	Window  string         `json:"window,omitempty"`
	Detail  map[string]any `json:"detail"`
}

// EventsResult is the response payload for cursor-based event queries.
type EventsResult struct {
	Events  []Event `json:"events"`
	NextSeq int64   `json:"next_seq"`
	HasMore bool    `json:"has_more"`
}
