package main

import (
	"bufio"
	"context"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const DefaultExecMaxBytes = 64 * 1024 * 1024 // 64MB

func parseExecMaxBytes() int64 {
	val := os.Getenv("AGENTBOX_AUDIT_EXEC_MB")
	if val != "" {
		if mb, err := strconv.ParseInt(strings.TrimSpace(val), 10, 64); err == nil && mb > 0 {
			return mb * 1024 * 1024
		}
	}
	return DefaultExecMaxBytes
}

var (
	truncMu       sync.Mutex
	lastTruncSize int64
)

// CapExecLog truncates the file in place to approximately maxBytes/2 when it exceeds maxBytes,
// preserving the tail (most recent lines) and discarding any leading partial line.
func CapExecLog(filePath string, maxBytes int64) error {
	if maxBytes <= 0 {
		return nil
	}

	fi, err := os.Stat(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	fileSize := fi.Size()
	if fileSize <= maxBytes {
		return nil
	}

	targetRetain := maxBytes / 2
	if targetRetain < 1 {
		targetRetain = 1
	}
	startOffset := fileSize - targetRetain
	if startOffset < 0 {
		startOffset = 0
	}

	f, err := os.OpenFile(filePath, os.O_RDWR, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	if _, err := f.Seek(startOffset, io.SeekStart); err != nil {
		return err
	}

	reader := bufio.NewReader(f)
	var discardLen int64 = 0
	if startOffset > 0 {
		partial, err := reader.ReadString('\n')
		if err != nil && err != io.EOF {
			return err
		}
		discardLen = int64(len(partial))
	}

	actualStart := startOffset + discardLen
	if actualStart >= fileSize {
		// Nothing left to copy, truncate to 0
		if err := f.Truncate(0); err != nil {
			return err
		}
		truncMu.Lock()
		lastTruncSize = 0
		truncMu.Unlock()
		return nil
	}

	if _, err := f.Seek(actualStart, io.SeekStart); err != nil {
		return err
	}

	var writePos int64 = 0
	buf := make([]byte, 64*1024)

	for {
		readPos, err := f.Seek(0, io.SeekCurrent)
		if err != nil {
			return err
		}

		n, readErr := f.Read(buf)
		if n > 0 {
			if _, err := f.Seek(writePos, io.SeekStart); err != nil {
				return err
			}
			if _, err := f.Write(buf[:n]); err != nil {
				return err
			}
			writePos += int64(n)

			if _, err := f.Seek(readPos+int64(n), io.SeekStart); err != nil {
				return err
			}
		}

		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}

	if err := f.Truncate(writePos); err != nil {
		return err
	}
	_ = f.Sync()

	truncMu.Lock()
	lastTruncSize = writePos
	truncMu.Unlock()

	return nil
}

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

// IsSupervisorSelfExec reports exec lines that are the supervisor's own processes, not anything a
// person or agent ran. Snoopy's exclude_spawns_of drops their *children* at the execve() layer, but
// the box-healthcheck self-exec is emitted by the container health probe, whose ancestry lives
// outside the container and cannot be matched — and Snoopy 2.5.2 has no exclude_comm filter. So the
// drop happens here, at ingestion: exec.log keeps the raw record, the event stream does not.
func IsSupervisorSelfExec(cmd string) bool {
	c := strings.TrimSpace(cmd)
	return c == "/usr/local/bin/box-healthcheck" || c == "box-healthcheck"
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

	var offset int64 = -1

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

		if offset < 0 {
			// On daemon startup, seed from the last 1MB rather than reprocessing gigabytes of logs
			const maxInitialSeed = 1024 * 1024 // 1 MB
			if fi.Size() > maxInitialSeed {
				offset = fi.Size() - maxInitialSeed
			} else {
				offset = 0
			}
		} else if fi.Size() < offset {
			// Handle truncation / rotation
			truncMu.Lock()
			isCapTruncate := lastTruncSize > 0 && fi.Size() >= lastTruncSize
			if isCapTruncate {
				offset = fi.Size()
				lastTruncSize = 0
			} else {
				offset = 0
			}
			truncMu.Unlock()
		}

		if _, err := file.Seek(offset, io.SeekStart); err != nil {
			_ = file.Close()
			time.Sleep(pollInterval)
			continue
		}

		reader := bufio.NewReader(file)
		// If we jumped into the middle of a file, skip partial first line
		if offset > 0 {
			if partial, err := reader.ReadString('\n'); err == nil {
				offset += int64(len(partial))
			}
		}

		for {
			line, err := reader.ReadString('\n')
			if len(line) > 0 {
				offset += int64(len(line))
				if ev := ParseSnoopyLine(line); ev != nil {
					if cmd, _ := ev.Detail["cmd"].(string); IsSupervisorSelfExec(cmd) {
						continue
					}
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
