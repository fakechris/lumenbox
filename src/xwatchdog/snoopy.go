package main

import (
	"bufio"
	"context"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// ParseSnoopyLine parses a single Snoopy log line into an Event.
// Format:
// time=2026-09-09 09:30:15 | uid=1000 | user=box | tty=/dev/pts/0 | pwd=/home/box/work | pid=123 | ppid=456 | cmd=ls -la
func ParseSnoopyLine(line string) *Event {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || !strings.HasPrefix(trimmed, "time=") {
		return nil
	}

	parts := strings.Split(trimmed, " | ")
	fields := make(map[string]string)
	for _, part := range parts {
		idx := strings.Index(part, "=")
		if idx != -1 {
			k := strings.TrimSpace(part[:idx])
			v := strings.TrimSpace(part[idx+1:])
			fields[k] = v
		}
	}

	rawTime := fields["time"]
	if rawTime == "" {
		return nil
	}

	// Normalize time to RFC3339
	isoTime := rawTime
	if t, err := time.Parse("2006-01-02 15:04:05", rawTime); err == nil {
		isoTime = t.UTC().Format(time.RFC3339)
	} else if t, err := time.Parse(time.RFC3339, rawTime); err == nil {
		isoTime = t.UTC().Format(time.RFC3339)
	}

	uid, _ := strconv.Atoi(fields["uid"])
	pid, _ := strconv.Atoi(fields["pid"])
	ppid, _ := strconv.Atoi(fields["ppid"])

	tty := fields["tty"]
	var window string
	if tty != "" && tty != "none" {
		window = "tty:" + tty
	}

	cmd := fields["cmd"]
	user := fields["user"]
	source := ClassifyExecSource(tty, cmd, user)
	probe := IsProbeCommand(cmd)

	return &Event{
		Type:   TypeExec,
		Time:   isoTime,
		Source: source,
		Probe:  probe,
		Window: window,
		Detail: map[string]any{
			"cmd":  cmd,
			"pwd":  fields["pwd"],
			"user": user,
			"uid":  uid,
			"tty":  tty,
			"pid":  pid,
			"ppid": ppid,
		},
	}
}

// IsProbeCommand checks if an exec command is an internal repetitive system supervisor health probe.
func IsProbeCommand(cmd string) bool {
	c := strings.TrimSpace(cmd)
	if strings.HasPrefix(c, "tr \\0 \\n") || strings.HasPrefix(c, "tr '\\0' '\\n'") || strings.HasPrefix(c, "tr \"\\0\" \"\\n\"") {
		return true
	}
	if strings.HasPrefix(c, "grep") && strings.Contains(c, "DISPLAY=") {
		return true
	}
	if strings.HasPrefix(c, "pgrep") && (strings.Contains(c, "pcmanfm") || strings.Contains(c, "xwatchdog") || strings.Contains(c, "autocutsel") || strings.Contains(c, "Xvfb")) {
		return true
	}
	if strings.HasPrefix(c, "xdpyinfo -display") {
		return true
	}
	return false
}

// ClassifyExecSource determines whether an exec event originated from human user, agent tool, or system daemon.
func ClassifyExecSource(tty string, cmd string, user string) string {
	if tty != "" && tty != "none" && (strings.Contains(tty, "pts") || strings.Contains(tty, "tty")) {
		return "user"
	}
	if IsProbeCommand(cmd) || user == "hostd" {
		return "system"
	}
	return "agent"
}

// TailSnoopyLog tails a file and feeds parsed events to store.
func TailSnoopyLog(ctx context.Context, filePath string, store *EventStore, pollInterval time.Duration) {
	if pollInterval <= 0 {
		pollInterval = 200 * time.Millisecond
	}

	var offset int64 = 0

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		file, err := os.Open(filePath)
		if err != nil {
			// File doesn't exist yet, wait and retry
			time.Sleep(pollInterval)
			continue
		}

		fi, err := file.Stat()
		if err != nil {
			_ = file.Close()
			time.Sleep(pollInterval)
			continue
		}

		// Handle truncation / rotation
		if fi.Size() < offset {
			offset = 0
		}

		if _, err := file.Seek(offset, io.SeekStart); err != nil {
			_ = file.Close()
			time.Sleep(pollInterval)
			continue
		}

		reader := bufio.NewReader(file)
		for {
			line, err := reader.ReadString('\n')
			if len(line) > 0 {
				offset += int64(len(line))
				if ev := ParseSnoopyLine(line); ev != nil {
					store.Append(*ev)
				}
			}
			if err != nil {
				break
			}
		}

		_ = file.Close()
		time.Sleep(pollInterval)
	}
}
