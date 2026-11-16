/**
 * A fork's last line (docs/32 §2): what its system prompt tells it to end with, and how the
 * turn that forked it reads that line back.
 */

/** The line a fork ends with, so its outcome is read rather than guessed from prose. */
export const HANDOFF_PREFIX = "HANDOFF: ";

/** The line a fork child's system prompt carries, so it knows what it is and is not. */
export const FORK_PROMPT_LINE =
  "# You are a fork\n\n" +
  "You were forked by your own main conversation to work one slice of a larger job. Your findings " +
  "go back to it as your final message — say them plainly and completely. You cannot message " +
  "anyone, change the task board, remember for the team, ask a person, or fork again; if a slice " +
  "needs one of those, say so in your findings and the turn that forked you will decide.\n\n" +
  "End your final message with exactly one line, on its own, of the form\n" +
  `${HANDOFF_PREFIX}{"status":"done","reason":"…"}\n` +
  'where status is "done" (the slice is complete), "partial" (some of it, say what is missing) or ' +
  '"blocked" (it needs something only the turn that forked you can do — say what). The reason is ' +
  "one sentence. The line is read by a program, so keep it exact and last.";

export interface Handoff {
  status: "done" | "partial" | "blocked" | "unstated";
  reason?: string;
  /** The findings with the handoff line removed. */
  body: string;
}

/**
 * Reads a fork's handoff line off the end of its findings.
 *
 * Fail-closed: no line, or a line that does not parse, or a status outside the three, is
 * `unstated` — reported as such, never promoted to done. A missing verdict is information
 * (the child ran out of context, or ignored the instruction), and the parent should see it
 * as that rather than as a quiet success. (Argus parses its roles' decision line the same
 * way; its incident log has a challenge channel that existed but was never reachable
 * because the parser and the prompt disagreed — hence the test that a well-formed line
 * changes what the parent is told.)
 */
export function readHandoff(findings: string): Handoff {
  const lines = findings.trimEnd().split("\n");
  const last = lines[lines.length - 1]?.trim() ?? "";
  if (!last.startsWith(HANDOFF_PREFIX)) return { status: "unstated", body: findings };
  const body = lines.slice(0, -1).join("\n").trimEnd();
  try {
    const parsed = JSON.parse(last.slice(HANDOFF_PREFIX.length)) as { status?: unknown; reason?: unknown };
    const status = parsed.status;
    if (status !== "done" && status !== "partial" && status !== "blocked") {
      return { status: "unstated", body };
    }
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 300) : undefined;
    return { status, body, ...(reason !== undefined && reason !== "" ? { reason } : {}) };
  } catch {
    return { status: "unstated", body };
  }
}
