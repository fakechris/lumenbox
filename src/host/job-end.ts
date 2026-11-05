/**
 * What a job's end is worth to the agent that started it (INV-1613).
 *
 * Measured 2026-11-03/04: of 1,575 wakes across five agents, 1,377 were "the command you
 * started earlier ended", and 1,209 of those ended with exit 0 — a `sleep 20; curl …` poll
 * that found nothing new, woken into a turn carrying 80–100k tokens of context. A finished
 * build and a finished sleep cost the same. So a command declares, when it starts, what its
 * end should do: wake the agent, wake only on failure (or when the output says something the
 * agent named), or just go on the record for the next turn to read.
 *
 * Defaults follow where the job came from. A foreground command that outlived its window was
 * not meant to be waited on, so it wakes only on failure; a job started with `background: true`
 * was never watched before this and still is not unless the agent asks.
 */

/** `on_end`, as the bash tool takes it. */
export type OnEnd = "wake" | "wake_on_failure" | "record";

export const ON_END_VALUES: readonly OnEnd[] = ["wake", "wake_on_failure", "record"];

/** The schema fragment the bash tool spreads into its properties. */
export function onEndSchema(): Record<string, unknown> {
  return {
    on_end: {
      type: "string",
      enum: [...ON_END_VALUES],
      description:
        "What to do when this command ends after your turn has moved on. `wake_on_failure` (the default for a " +
        "command that outlives its foreground window) wakes you only on a non-zero exit, or when the output matches " +
        "`wake_when`; `wake` wakes you whatever the exit; `record` never wakes you — the end is noted in your next " +
        "turn. A `background: true` job is not watched unless you pass this. To wait for a result you need now, " +
        "use `Jobs wait` instead of a sleep: it costs nothing while it waits.",
    },
    wake_when: {
      type: "string",
      description: "For `wake_on_failure`: also wake when the job's last output contains this text.",
    },
  };
}

/** The declared policy for a command, or undefined when the value is not one of ours. */
export function parseOnEnd(raw: unknown): OnEnd | undefined {
  return typeof raw === "string" && (ON_END_VALUES as readonly string[]).includes(raw) ? (raw as OnEnd) : undefined;
}

/**
 * A command whose whole body is waiting — `sleep 30`, `tail -f log`, `wait`, `inotifywait …` —
 * joined by `;`, `&&` or newlines. Its end carries no news, and the agent is told to use
 * `Jobs wait` instead of spending a turn on it.
 */
export function isWaitOnly(command: string): boolean {
  const steps = command
    .split(/\n|;|&&|\|\|/)
    .map(step => step.trim())
    .filter(step => step !== "" && step !== "true");
  if (steps.length === 0) return false;
  return steps.every(step => /^sleep\s+\d+(\.\d+)?[smhd]?$/.test(step) || /^wait(\s+\S+)?$/.test(step) || /^inotifywait\b/.test(step) || followsOneFile(step));
}

/** `tail -f <file>` in its spellings, an optional `timeout N` in front: flags, at most one count, one path. */
function followsOneFile(step: string): boolean {
  const words = step.split(/\s+/);
  if (words[0] === "timeout" && /^\d+[smhd]?$/.test(words[1] ?? "")) words.splice(0, 2);
  if (words.shift() !== "tail") return false;
  if (!words.some(word => /^-[a-zA-Z]*[fF][a-zA-Z]*$/.test(word) || /^--follow(=\S+)?$/.test(word))) return false;
  const paths = words.filter(word => !word.startsWith("-") && !/^[+-]?\d+[kMG]?$/.test(word));
  return paths.length === 1;
}

export interface JobEnd {
  exit_code?: number;
  interrupted?: boolean;
  killed?: boolean;
  tail: string;
}

/** Whether this end, under this policy, is worth a turn. */
export function wakesFor(policy: OnEnd, wakeWhen: string | undefined, ended: JobEnd): boolean {
  if (policy === "record") return false;
  if (policy === "wake") return true;
  const failed = ended.killed === true || ended.interrupted === true || (ended.exit_code !== undefined && ended.exit_code !== 0);
  if (failed) return true;
  return wakeWhen !== undefined && wakeWhen !== "" && ended.tail.includes(wakeWhen);
}

/** One line per job for the note the next turn opens with, when ends were recorded rather than woken for. */
export function recordedEndsNote(ends: readonly { jobId: string; command: string; exit_code?: number; interrupted?: boolean; killed?: boolean; log_path: string }[]): string | undefined {
  if (ends.length === 0) return undefined;
  const lines = ends.map(end => {
    const how = end.killed === true ? "stopped at the cap" : end.interrupted === true ? "exit unknown" : `exit ${end.exit_code ?? "?"}`;
    return `- ${end.jobId} (${how}): ${end.command.replace(/\s+/g, " ").slice(0, 120)} — log ${end.log_path}`;
  });
  return `[host] Since your last turn, ${ends.length === 1 ? "a command you started ended" : `${ends.length} commands you started ended`}; nothing woke you for ${ends.length === 1 ? "it" : "them"}:\n${lines.join("\n")}`;
}
