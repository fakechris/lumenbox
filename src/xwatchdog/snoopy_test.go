package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
	if ev.Source != "user" {
		t.Fatalf("expected source 'user', got %s", ev.Source)
	}
	if ev.Probe {
		t.Fatalf("expected probe false, got true")
	}

	// Probe line
	probeLine := "time=2026-09-09 09:30:16 | uid=1000 | user=box | tty=none | pwd=/home/box | pid=124 | ppid=456 | cmd=tr \\0 \\n"
	probeEv := ParseSnoopyLine(probeLine)
	if probeEv == nil {
		t.Fatal("expected parsed probe event, got nil")
	}
	if !probeEv.Probe {
		t.Fatalf("expected probe true for tr \\0 \\n")
	}
	if probeEv.Source != "system" {
		t.Fatalf("expected source 'system' for probe event, got %s", probeEv.Source)
	}

	// Agent tool line (tty=none, non-probe)
	agentLine := "time=2026-09-09 09:30:17 | uid=1000 | user=box | tty=none | pwd=/home/box/work | pid=125 | ppid=456 | cmd=pytest"
	agentEv := ParseSnoopyLine(agentLine)
	if agentEv == nil {
		t.Fatal("expected parsed agent event, got nil")
	}
	if agentEv.Probe {
		t.Fatalf("expected probe false for pytest")
	}
	if agentEv.Source != "agent" {
		t.Fatalf("expected source 'agent' for agent tool, got %s", agentEv.Source)
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

func TestIsProbeCommand(t *testing.T) {
	probes := []string{
		"tr \\0 \\n",
		"tr '\\0' '\\n'",
		"grep -Fqx DISPLAY=:1",
		"grep -Fqxz DISPLAY=:1 /proc/123/environ",
		"pgrep -f -- pcmanfm --desktop",
		"pgrep -f xwatchdog",
		"pgrep -f autocutsel",
		"xdpyinfo -display :1",
	}
	for _, p := range probes {
		if !IsProbeCommand(p) {
			t.Errorf("expected IsProbeCommand(%q) to be true", p)
		}
	}

	nonProbes := []string{
		"git status",
		"npm test",
		"python3 app.py",
		"tr a-z A-Z",
		"grep foo bar.txt",
	}
	for _, np := range nonProbes {
		if IsProbeCommand(np) {
			t.Errorf("expected IsProbeCommand(%q) to be false", np)
		}
	}
}

func TestClassifyExecSource(t *testing.T) {
	if s := ClassifyExecSource("/dev/pts/1", "ls", "box"); s != "user" {
		t.Errorf("expected user, got %s", s)
	}
	if s := ClassifyExecSource("none", "node hostd.mjs", "hostd"); s != "system" {
		t.Errorf("expected system, got %s", s)
	}
	if s := ClassifyExecSource("none", "tr \\0 \\n", "box"); s != "system" {
		t.Errorf("expected system for probe, got %s", s)
	}
	if s := ClassifyExecSource("none", "pytest tests/", "box"); s != "agent" {
		t.Errorf("expected agent, got %s", s)
	}
}

func TestCapExecLogLeavesSmallFile(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "xwatchdog-cap-small-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	execPath := filepath.Join(tmpDir, "exec.log")
	content := "time=2026-09-09 09:30:15 | uid=1000 | user=box | tty=pts/0 | pwd=/home/box | pid=10 | ppid=1 | cmd=echo hello\n"
	if err := os.WriteFile(execPath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	// Ceiling 10KB, file is ~110 bytes
	if err := CapExecLog(execPath, 10*1024); err != nil {
		t.Fatalf("CapExecLog error: %v", err)
	}

	data, err := os.ReadFile(execPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != content {
		t.Fatalf("expected small file to remain unchanged, got %s", string(data))
	}
}

func TestCapExecLog(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "xwatchdog-cap-large-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	execPath := filepath.Join(tmpDir, "exec.log")
	f, err := os.Create(execPath)
	if err != nil {
		t.Fatal(err)
	}

	// Write ~2000 lines (~200KB)
	for i := 1; i <= 2000; i++ {
		line := fmt.Sprintf("time=2026-09-09 09:30:15 | uid=1000 | user=box | tty=pts/0 | pwd=/home/box | pid=%d | ppid=1 | cmd=echo line-%d\n", i, i)
		_, _ = f.WriteString(line)
	}
	_ = f.Close()

	fiBefore, err := os.Stat(execPath)
	if err != nil {
		t.Fatal(err)
	}

	// Cap at 64KB, targetRetain is ~32KB
	const maxBytes = 64 * 1024
	if err := CapExecLog(execPath, maxBytes); err != nil {
		t.Fatalf("CapExecLog failed: %v", err)
	}

	fiAfter, err := os.Stat(execPath)
	if err != nil {
		t.Fatal(err)
	}

	if fiAfter.Size() > maxBytes {
		t.Fatalf("expected capped file <= %d, got %d", maxBytes, fiAfter.Size())
	}
	if fiAfter.Size() >= fiBefore.Size() {
		t.Fatalf("expected file to shrink from %d, got %d", fiBefore.Size(), fiAfter.Size())
	}

	// Read and verify first and last lines
	data, err := os.ReadFile(execPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) == 0 {
		t.Fatal("expected lines in capped file")
	}

	// First line should be a complete valid Snoopy line
	if !strings.HasPrefix(lines[0], "time=") {
		t.Fatalf("expected first line to start with time=, got: %s", lines[0])
	}
	// Last line should match the final line written (line-2000)
	lastLine := lines[len(lines)-1]
	if !strings.Contains(lastLine, "line-2000") {
		t.Fatalf("expected last line to contain line-2000, got: %s", lastLine)
	}
}
