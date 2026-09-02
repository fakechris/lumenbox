/**
 * Lifecycle hooks in Claude Code's dialect, so a hook file written for Claude Code runs here
 * unchanged.
 *
 * The vocabulary is theirs on purpose: `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`; a
 * `matcher` regex against the tool name; a shell command that reads a JSON event on stdin and
 * answers with its exit code (2 blocks, and stderr is the reason the model sees) or with JSON on
 * stdout (`decision: "block"` or `hookSpecificOutput.permissionDecision: "deny"`). Adopting the
 * dialect instead of inventing one means every hook script already written is portable for
 * free — the R36 hot-extension seam without a second format to document.
 *
 * Read from `~/.agentbox/hooks.json`, which may be a Claude Code `settings.json` (the `hooks`
 * key is used) or the bare hooks object. Re-read when its mtime changes, so an edit takes effect
 * on the next turn without a restart. A hook that fails to run is a log line; only a hook that
 * *answers* "block" blocks.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop" | "PreCompact";

export interface HookCommand {
  type: "command";
  command: string;
  /** Seconds. Claude Code's default is 60. */
  timeout?: number;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>;

export interface HookOutcome {
  /** True when any hook asked to block, with the first reason. */
  blocked: boolean;
  reason?: string;
  /** How many hook commands ran. Zero means nothing matched. */
  ran: number;
}

const EVENTS: readonly HookEvent[] = ["PreToolUse", "PostToolUse", "Stop", "PreCompact"];

/** The hooks in a settings object, or in a bare hooks object. Unknown events are ignored. */
export function parseHooksConfig(raw: unknown): HooksConfig {
  const source =
    raw !== null && typeof raw === "object" && "hooks" in raw && typeof (raw as { hooks: unknown }).hooks === "object"
      ? (raw as { hooks: Record<string, unknown> }).hooks
      : (raw as Record<string, unknown> | null);
  const config: HooksConfig = {};
  if (source === null || typeof source !== "object") return config;
  for (const event of EVENTS) {
    const entries = source[event];
    if (!Array.isArray(entries)) continue;
    const matchers: HookMatcher[] = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object") continue;
      const { matcher, hooks } = entry as { matcher?: unknown; hooks?: unknown };
      if (!Array.isArray(hooks)) continue;
      const commands = hooks
        .filter(
          (hook): hook is HookCommand =>
            hook !== null && typeof hook === "object" && (hook as { type?: unknown }).type === "command" &&
            typeof (hook as { command?: unknown }).command === "string"
        )
        .map(hook => ({
          type: "command" as const,
          command: hook.command,
          ...(typeof hook.timeout === "number" ? { timeout: hook.timeout } : {}),
        }));
      if (commands.length === 0) continue;
      matchers.push({ ...(typeof matcher === "string" ? { matcher } : {}), hooks: commands });
    }
    if (matchers.length > 0) config[event] = matchers;
  }
  return config;
}

function matches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (toolName === undefined) return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName) || new RegExp(matcher).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

/** Reads a hook's stdout for a block decision, in either of the two shapes Claude Code accepts. */
function decisionFrom(stdout: string): { block: boolean; reason?: string } | undefined {
  const match = /\{[\s\S]*\}/.exec(stdout);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as {
      decision?: unknown;
      reason?: unknown;
      continue?: unknown;
      stopReason?: unknown;
      hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown };
    };
    const reason = (value: unknown) => (typeof value === "string" ? value : undefined);
    if (parsed.hookSpecificOutput?.permissionDecision === "deny") {
      return { block: true, reason: reason(parsed.hookSpecificOutput.permissionDecisionReason) };
    }
    if (parsed.decision === "block") return { block: true, reason: reason(parsed.reason) };
    if (parsed.continue === false) return { block: true, reason: reason(parsed.stopReason) };
    return { block: false };
  } catch {
    return undefined;
  }
}

export interface HookRunnerDeps {
  /** Where the config lives. Null means an in-memory config only, for tests. */
  path: string | null;
  config?: HooksConfig;
  cwd?: string;
  log?: (line: string) => void;
}

export class HookRunner {
  private config: HooksConfig;
  private loadedAt = 0;

  constructor(private readonly deps: HookRunnerDeps) {
    this.config = deps.config ?? {};
    this.reload();
  }

  /** Whether anything is configured for this event, so callers can skip building a payload. */
  has(event: HookEvent, toolName?: string): boolean {
    this.reload();
    return (this.config[event] ?? []).some(entry => matches(entry.matcher, toolName));
  }

  /**
   * Runs every matching hook for the event, in order, and reports the first block.
   *
   * Every hook runs even after one blocks — Claude Code does the same, and a hook that logs
   * must not be skipped because a sibling vetoed.
   */
  async run(event: HookEvent, payload: Record<string, unknown>): Promise<HookOutcome> {
    this.reload();
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    const outcome: HookOutcome = { blocked: false, ran: 0 };
    const input = JSON.stringify({ hook_event_name: event, cwd: this.deps.cwd ?? process.cwd(), ...payload });
    for (const entry of this.config[event] ?? []) {
      if (!matches(entry.matcher, toolName)) continue;
      for (const hook of entry.hooks) {
        outcome.ran += 1;
        const result = await this.exec(hook, input);
        if (result === undefined) continue;
        const decided = result.code === 2 ? { block: true, reason: result.stderr.trim() } : decisionFrom(result.stdout);
        if (decided?.block && !outcome.blocked) {
          outcome.blocked = true;
          outcome.reason = decided.reason || result.stderr.trim() || `blocked by hook: ${hook.command}`;
        }
        if (result.code !== 0 && result.code !== 2) {
          this.deps.log?.(`${event} hook exited ${result.code} (${hook.command}): ${result.stderr.trim().slice(0, 300)}`);
        }
      }
    }
    return outcome;
  }

  private reload(): void {
    if (this.deps.path === null) return;
    try {
      if (!existsSync(this.deps.path)) {
        if (this.loadedAt !== 0) this.config = {};
        this.loadedAt = 0;
        return;
      }
      const mtime = statSync(this.deps.path).mtimeMs;
      if (mtime === this.loadedAt) return;
      this.config = parseHooksConfig(JSON.parse(readFileSync(this.deps.path, "utf8")));
      this.loadedAt = mtime;
      const count = Object.values(this.config).reduce((sum, entries) => sum + entries.length, 0);
      this.deps.log?.(`loaded ${count} hook matcher(s) from ${this.deps.path}`);
    } catch (error) {
      this.deps.log?.(`could not read ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private exec(hook: HookCommand, input: string): Promise<{ code: number; stdout: string; stderr: string } | undefined> {
    return new Promise(resolve => {
      const child = spawn("sh", ["-c", hook.command], {
        cwd: this.deps.cwd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: this.deps.cwd ?? process.cwd() },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        this.deps.log?.(`hook timed out after ${hook.timeout ?? 60}s: ${hook.command}`);
      }, (hook.timeout ?? 60) * 1000);
      child.stdout.on("data", chunk => (stdout += String(chunk)));
      child.stderr.on("data", chunk => (stderr += String(chunk)));
      child.on("error", error => {
        clearTimeout(timer);
        this.deps.log?.(`hook could not start (${hook.command}): ${error.message}`);
        resolve(undefined);
      });
      child.on("close", code => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      child.stdin.on("error", () => {
        // A hook that does not read stdin closes it; that is not an error worth a line.
      });
      child.stdin.end(input);
    });
  }
}
