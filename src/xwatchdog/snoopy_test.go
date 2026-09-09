package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseSnoopyLine(t *testing.T) {
	line := "time=2026-09-09 09:30:15 | uid=1000 | user=box | tty=/dev/pts/0 | pwd=/home/box/work | pid=123 | ppid=456 | cmd=git status -s"
	ev := ParseSnoopyLine(line)
	if ev == nil {
		t.Fatal("expected parsed event, got nil")
	}

	if ev.Type != TypeExec {
		t.Fatalf("expected type exec, got %s", ev.Type)
	}
	if ev.Detail["cmd"] != "git status -s" {
		t.Fatalf("expected cmd 'git status -s', got %v", ev.Detail["cmd"])
	}
	if ev.Detail["user"] != "box" || ev.Detail["uid"] != 1000 {
		t.Fatalf("expected user box(1000), got %v(%v)", ev.Detail["user"], ev.Detail["uid"])
	}
	if ev.Window != "tty:/dev/pts/0" {
		t.Fatalf("expected window tty:/dev/pts/0, got %s", ev.Window)
	}
}

func TestTailSnoopyLog(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "xwatchdog-snoopy-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	logPath := filepath.Join(tmpDir, "exec.log")
	store := NewEventStore(100, "")
	defer store.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go TailSnoopyLog(ctx, logPath, store, 50*time.Millisecond)

	// Append lines with delay
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		t.Fatal(err)
	}

	_, _ = f.WriteString("time=2026-09-09 09:30:00 | uid=1000 | user=box | tty=/dev/pts/0 | pwd=/home/box | pid=10 | ppid=1 | cmd=whoami\n")
	_ = f.Sync()

	time.Sleep(150 * time.Millisecond)

	res := store.Query(0, 10)
	if len(res.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(res.Events))
	}
	if res.Events[0].Detail["cmd"] != "whoami" {
		t.Fatalf("expected whoami, got %v", res.Events[0].Detail["cmd"])
	}

	_ = f.Close()
}
