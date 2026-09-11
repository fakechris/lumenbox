package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	defaultDisplay := os.Getenv("DISPLAY")
	if defaultDisplay == "" {
		defaultDisplay = ":1"
	}

	displayFlag := flag.String("display", defaultDisplay, "X11 display to monitor (e.g. :1)")
	portFlag := flag.Int("port", 49099, "HTTP port to bind")
	bindFlag := flag.String("bind", "127.0.0.1", "HTTP bind address")
	snoopyLogFlag := flag.String("snoopy-log", "/var/log/xwatchdog/exec.log", "Path to Snoopy log file")
	persistLogFlag := flag.String("persist-log", "/var/log/xwatchdog/events.jsonl", "Path to persistent JSONL log")
	flag.Parse()

	// Parse numeric display index
	dispNum := 1
	dispClean := strings.TrimPrefix(*displayFlag, ":")
	if n, err := strconv.Atoi(dispClean); err == nil {
		dispNum = n
	}

	// Initialize EventStore
	store := NewEventStore(20000, *persistLogFlag)
	defer store.Close()

	// Log daemon startup
	store.Append(Event{
		Type:    TypeSystem,
		Time:    time.Now().UTC().Format(time.RFC3339),
		Display: dispNum,
		Detail: map[string]any{
			"action":  "startup",
			"display": *displayFlag,
			"pid":     os.Getpid(),
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 1. Tail Snoopy logs
	go TailSnoopyLog(ctx, *snoopyLogFlag, store, 200*time.Millisecond)

	// Periodic exec.log size check & copy-truncate保尾 (INV-462)
	execLogMaxBytes := parseExecMaxBytes()
	_ = CapExecLog(*snoopyLogFlag, execLogMaxBytes)
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := CapExecLog(*snoopyLogFlag, execLogMaxBytes); err != nil {
					log.Printf("[xwatchdog] cap exec.log error: %v", err)
				}
			}
		}
	}()

	// 2. Window-focus monitoring (which app was in front, never what was typed into it).
	focus := NewWindowFocus(dispNum, store)
	go MonitorX11(ctx, *displayFlag, dispNum, focus, 500*time.Millisecond)

	// 3. Heartbeat: a system event on a fixed cadence, so silence is detectable.
	//
	// The box user has sudo and can kill this daemon; nothing inside the box can truly stop them.
	// The tamper-evidence therefore lives on the host, which they do not control: the host pulls
	// events by sequence, and a heartbeat that stops (killed) or a sequence that gaps (log wiped)
	// is the high-risk signal it alarms on. SIGKILL cannot be caught here, but it cannot suppress
	// the missing heartbeat either.
	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				store.Append(Event{
					Type:    TypeSystem,
					Time:    time.Now().UTC().Format(time.RFC3339),
					Source:  "system",
					Display: dispNum,
					Detail:  map[string]any{"action": "heartbeat", "pid": os.Getpid()},
				})
			}
		}
	}()

	// 4. HTTP Server
	server := NewServer(store)
	addr := fmt.Sprintf("%s:%d", *bindFlag, *portFlag)
	httpServer := &http.Server{
		Addr:         addr,
		Handler:      server.Routes(),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("[xwatchdog] listening on http://%s (display %s)", addr, *displayFlag)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[xwatchdog] HTTP server failed: %v", err)
		}
	}()

	// 5. Signal Trapping (Security Tamper Detection)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)

	sig := <-sigChan
	log.Printf("[xwatchdog] received signal %v; shutting down", sig)

	// Record shutdown attempt to store before dying
	store.Append(Event{
		Type:    TypeSystem,
		Time:    time.Now().UTC().Format(time.RFC3339),
		Source:  "system",
		Display: dispNum,
		Detail: map[string]any{
			"action": "shutdown_signal",
			"signal": sig.String(),
			"pid":    os.Getpid(),
		},
	})

	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer shutdownCancel()
	_ = httpServer.Shutdown(shutdownCtx)
}
