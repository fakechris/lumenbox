/**
 * Box-side service reading Snoopy exec logs and XWatchdog GUI logs,
 * normalizing them into unified, chronologically ordered XWatchdogEvent items
 * with monotonic sequence numbers for cursor-based streaming to the host server.
 *
 * Communicates with the native Go xwatchdog daemon over local loopback,
 * falling back to reading raw/persistent log files if the daemon is starting up.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { XWatchdogEvent, XWatchdogEventsResult } from "../protocol/index.ts";

export const DEFAULT_EXEC_LOG_PATH = "/var/log/xwatchdog/exec.log";
export const DEFAULT_GUI_LOG_PATH = "/var/log/xwatchdog/gui.log";
export const DEFAULT_EVENTS_LOG_PATH = "/var/log/xwatchdog/events.jsonl";
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:49099";

/**
 * Recognizes recurring system supervisor health check probes (e.g. from start-display running_here).
 */
export function isProbeCommand(cmd: string): boolean {
  const c = cmd.trim();
  if (/^tr\s+(['"]?)\\0\1\s+(['"]?)\\n\2/.test(c)) return true;
  if (/^grep\s+.*DISPLAY=/.test(c)) return true;
  if (/^pgrep\s+-(f\s+--?\s*|f\s+)(pcmanfm|xwatchdog|autocutsel|Xvfb)/.test(c)) return true;
  if (/^xdpyinfo\s+-display/.test(c)) return true;
  // The container health probe's own exec line: the Go daemon drops it at ingestion, but the
  // file-fallback path can still read it from a raw exec.log.
  if (/^(\/\S+\/)?box-healthcheck(\s|$)/.test(c)) return true;
  return false;
}

/**
 * Determines whether an exec command originates from a human user terminal, an agent tool,
 * or a system daemon / supervisor probe.
 */
export function classifyExecSource(
  tty: string | undefined,
  cmd: string,
  user: string | undefined
): "user" | "agent" | "system" {
  if (tty && tty !== "none" && (tty.includes("pts") || tty.includes("tty"))) {
    return "user";
  }
  if (isProbeCommand(cmd) || user === "hostd") {
    return "system";
  }
  return "agent";
}

export interface XWatchdogServiceOptions {
  execLogPath?: string;
  guiLogPath?: string;
  eventsLogPath?: string;
  daemonUrl?: string;
}

export class XWatchdogService {
  private readonly execLogPath: string;
  private readonly guiLogPath: string;
  private readonly eventsLogPath: string;
  private readonly daemonUrl: string;

  constructor(options: XWatchdogServiceOptions = {}) {
    this.execLogPath = options.execLogPath ?? DEFAULT_EXEC_LOG_PATH;
    this.guiLogPath = options.guiLogPath ?? DEFAULT_GUI_LOG_PATH;
    this.eventsLogPath = options.eventsLogPath ?? DEFAULT_EVENTS_LOG_PATH;
    this.daemonUrl = options.daemonUrl ?? DEFAULT_DAEMON_URL;
  }

  /**
   * Queries events via the native Go xwatchdog daemon or falls back to reading files.
   */
  async events(since = 0, limit = 100, tail = false): Promise<XWatchdogEventsResult> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));

    // 1. Try the native daemon via loopback. If it answers, it is up.
    try {
      const url = tail
        ? `${this.daemonUrl}/events?tail=1&limit=${boundedLimit}`
        : `${this.daemonUrl}/events?since=${since}&limit=${boundedLimit}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(600),
      });
      if (res.ok) {
        const body = (await res.json()) as XWatchdogEventsResult;
        return this.withHealth(body, true);
      }
    } catch {
      // Daemon unreachable. On a box whose user can sudo, that is not always "starting up" —
      // it can be a killed auditor, which is exactly the high-risk signal to surface.
    }

    // 2. Fallback: parse the persisted log. The daemon is down; mark it so.
    return this.withHealth(this.eventsFromFiles(since, boundedLimit, tail), false);
  }

  /**
   * Adds tamper-evidence the host can act on.
   *
   * daemon_up is whether the loopback query succeeded; heartbeat_age_ms is how long since the
   * newest heartbeat this call saw (the daemon emits one every 10s). at_risk is true when the
   * daemon is down or the heartbeat is older than a few missed beats. The host decides what to do
   * with at_risk — the point is that a killed auditor cannot hide the silence, because the host
   * that reads this is not the box the sudo user controls.
   */
  private withHealth(result: XWatchdogEventsResult, daemonUp: boolean): XWatchdogEventsResult {
    const beats = result.events.filter(
      e => e.type === "system" && (e.detail as { action?: unknown }).action === "heartbeat"
    );
    const newest = beats.length > 0 ? beats[beats.length - 1] : undefined;
    const ageMs = newest ? Math.max(0, Date.now() - Date.parse(newest.time)) : undefined;
    // at_risk keys on "did the daemon answer", which is authoritative and false-positive free: a
    // killed daemon cannot answer, and that is the case the operator must see. heartbeat_age_ms
    // rides along as informational; catching a *wedged* (alive but stuck) daemon reliably needs
    // the host to track the max heartbeat across polls, which is the next slice (docs/47).
    return {
      ...result,
      daemon_up: daemonUp,
      ...(ageMs !== undefined ? { heartbeat_age_ms: ageMs } : {}),
      at_risk: !daemonUp,
    };
  }

  /**
   * Parses a single line from Snoopy log.
   * Expected format:
   * time=2026-09-09 09:30:15 | uid=1000 | user=box | tty=/dev/pts/0 | pwd=/home/box/work | pid=123 | ppid=456 | cmd=ls -la
   */
  parseExecLine(line: string): Omit<XWatchdogEvent, "seq"> | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith("time=")) return undefined;

    const parts = trimmed.split(" | ");
    const fields: Record<string, string> = {};

    for (const part of parts) {
      const idx = part.indexOf("=");
      if (idx !== -1) {
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        fields[key] = value;
      }
    }

    const rawTime = fields.time;
    if (!rawTime) return undefined;

    // Normalize timestamp to ISO string
    let isoTime: string;
    try {
      const parsed = new Date(rawTime.includes("T") ? rawTime : `${rawTime.replace(" ", "T")}Z`);
      isoTime = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
    } catch {
      isoTime = new Date().toISOString();
    }

    const uid = fields.uid ? Number(fields.uid) : undefined;
    const pid = fields.pid ? Number(fields.pid) : undefined;
    const ppid = fields.ppid ? Number(fields.ppid) : undefined;
    const tty = fields.tty ?? "";
    const cmd = fields.cmd ?? "";
    const user = fields.user ?? "box";
    const window = tty && tty !== "none" ? `tty:${tty}` : undefined;
    const probe = isProbeCommand(cmd);
    const source = classifyExecSource(tty, cmd, user);

    return {
      type: "exec",
      time: isoTime,
      source,
      ...(probe ? { probe: true } : {}),
      ...(window ? { window } : {}),
      detail: {
        cmd,
        pwd: fields.pwd ?? "",
        user,
        uid,
        tty,
        pid,
        ppid,
      },
    };
  }

  /**
   * Parses a single JSON line from GUI log.
   */
  parseGuiLine(line: string): Omit<XWatchdogEvent, "seq"> | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return undefined;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const type = parsed.type;
      if (type !== "window_focus" && type !== "exec" && type !== "system") {
        // Older logs may carry gui_click/gui_input from before this was made content-free
        // (docs/47). Dropped on read, so a rebuilt box stops surfacing captured keystrokes.
        return undefined;
      }

      const time = typeof parsed.time === "string" ? parsed.time : new Date().toISOString();
      const display = typeof parsed.display === "number" ? parsed.display : undefined;
      const window = typeof parsed.window === "string" ? parsed.window : undefined;
      const detail =
        parsed.detail && typeof parsed.detail === "object"
          ? (parsed.detail as Record<string, unknown>)
          : {};

      let source = typeof parsed.source === "string" ? (parsed.source as "user" | "agent" | "system") : undefined;
      if (!source) {
        if (type === "window_focus") source = "user";
        else if (type === "system") source = "system";
      }

      return {
        type,
        time,
        ...(source ? { source } : {}),
        ...(parsed.probe === true ? { probe: true } : {}),
        display,
        window,
        detail,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Reads raw lines from a log file safely. If maxBytes is provided and file exceeds it,
   * reads only the last maxBytes bytes from the end of the file.
   */
  private readLines(filePath: string, maxBytes?: number): string[] {
    if (!existsSync(filePath)) return [];
    try {
      if (maxBytes !== undefined) {
        const stats = statSync(filePath);
        if (stats.size > maxBytes) {
          const fd = openSync(filePath, "r");
          try {
            const buf = Buffer.alloc(maxBytes);
            const offset = stats.size - maxBytes;
            readSync(fd, buf, 0, maxBytes, offset);
            const content = buf.toString("utf8");
            const lines = content.split("\n");
            // Discard first line as it may be partially truncated
            if (lines.length > 1) lines.shift();
            return lines.filter(l => l.trim().length > 0);
          } finally {
            closeSync(fd);
          }
        }
      }
      const content = readFileSync(filePath, "utf8");
      return content.split("\n").filter(l => l.trim().length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Reads events directly from on-disk log files.
   */
  eventsFromFiles(since = 0, limit = 100, tail = false): XWatchdogEventsResult {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const allParsed: Omit<XWatchdogEvent, "seq">[] = [];
    const maxBytes = tail ? 2 * 1024 * 1024 : undefined;

    // 1. If persistent events.jsonl exists, read directly
    if (existsSync(this.eventsLogPath)) {
      for (const line of this.readLines(this.eventsLogPath, maxBytes)) {
        const parsed = this.parseGuiLine(line);
        if (parsed) allParsed.push(parsed);
      }
    } else {
      // Otherwise merge exec.log and gui.log
      for (const line of this.readLines(this.execLogPath, maxBytes)) {
        const parsed = this.parseExecLine(line);
        if (parsed) allParsed.push(parsed);
      }
      for (const line of this.readLines(this.guiLogPath, maxBytes)) {
        const parsed = this.parseGuiLine(line);
        if (parsed) allParsed.push(parsed);
      }
    }

    // Sort chronologically
    allParsed.sort((a, b) => {
      const ta = Date.parse(a.time) || 0;
      const tb = Date.parse(b.time) || 0;
      return ta - tb;
    });

    // Refine process lineage: children of agent shells inherit "agent" source
    const agentPids = new Set<number>();
    for (const ev of allParsed) {
      if (ev.type === "exec") {
        const cmd = String(ev.detail.cmd || "");
        const pid = typeof ev.detail.pid === "number" ? ev.detail.pid : undefined;
        const ppid = typeof ev.detail.ppid === "number" ? ev.detail.ppid : undefined;
        if (cmd.startsWith("nice -n") || cmd.includes("boxd-session-")) {
          if (pid) agentPids.add(pid);
          ev.source = "agent";
        } else if (ppid && agentPids.has(ppid)) {
          if (pid) agentPids.add(pid);
          if (!ev.probe) ev.source = "agent";
        }
      }
    }

    // Assign monotonic sequence
    const sequenced: XWatchdogEvent[] = allParsed.map((ev, index) => ({
      ...ev,
      seq: index + 1,
    }));

    if (tail) {
      const slice = sequenced.slice(-boundedLimit);
      const nextSeq = slice.length > 0 ? (slice[slice.length - 1]?.seq ?? sequenced.length) : sequenced.length;
      return {
        events: slice,
        next_seq: nextSeq,
        has_more: false,
      };
    }

    const filtered = sequenced.filter(e => e.seq > since);
    const slice = filtered.slice(0, boundedLimit);
    const hasMore = filtered.length > boundedLimit;
    const nextSeq = slice.length > 0 ? (slice[slice.length - 1]?.seq ?? since) : since;

    return {
      events: slice,
      next_seq: nextSeq,
      has_more: hasMore,
    };
  }
}
