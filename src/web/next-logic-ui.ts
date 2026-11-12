/**
 * What the rebuilt page decides for itself (INV-1825) — which is as little as possible.
 *
 * docs/99 §4 is the contract: work has an execution state and an acceptance state, and the page
 * shows one word and one sentence for it. The server already reads those facts into `reading`
 * (work-reading.ts); these functions only choose the word, the group and the order. They are plain
 * functions shipped to the page as their own source, so the test and the page run the same code.
 */

/** The word a row carries, and the colour family it belongs to. */
function nextStateOf(row: { status: string; reading?: { phase: string; blocker?: { kind: string } } }): { key: string; tone: string } {
  const phase = row.reading?.phase ?? "";
  const blocker = row.reading?.blocker?.kind ?? "";
  if (phase === "proposal") return { key: "proposal", tone: "idle" };
  if (phase === "dropped") return { key: "stopped", tone: "idle" };
  if (phase === "ended") return { key: "done", tone: "done" };
  if (phase === "review") return { key: "review", tone: "need" };
  if (phase === "checking") return { key: "checking", tone: "run" };
  if (phase === "working") return { key: "running", tone: "run" };
  if (phase === "queued") return { key: "queued", tone: "run" };
  // Waiting on a tool or after a failure is stuck; waiting on the person is theirs to answer.
  if (blocker === "capability" || blocker === "failed" || blocker === "interrupted") return { key: "stuck", tone: "stuck" };
  if (phase === "needs" || blocker === "confirmation") return { key: "answer", tone: "need" };
  // A request between two slices of its own is still being worked on.
  if (blocker === "execution" && row.status === "doing") return { key: "running", tone: "run" };
  return { key: "waiting", tone: "idle" };
}

/** Which section of the work view a row sits in. */
function nextGroupOf(stateKey: string): string {
  if (stateKey === "running" || stateKey === "queued" || stateKey === "checking" || stateKey === "waiting") return "running";
  if (stateKey === "answer" || stateKey === "stuck" || stateKey === "proposal") return "you";
  if (stateKey === "review") return "review";
  return "done";
}

/** Which section of the inbox an attention item sits in. */
function nextInboxGroupOf(kind: string): string {
  if (kind === "approval" || kind === "outbox" || kind === "close-proposal" || kind === "reauthorize") return "approve";
  if (kind === "question" || kind === "unanswered") return "answer";
  if (kind === "review") return "review";
  if (kind === "paused" || kind === "undeliverable" || kind === "exception" || kind === "spend-limit" || kind === "provider-resting" || kind === "routine-paused" || kind === "boundary-probe") return "stuck";
  return "other";
}

/** The newest progress a row has numbers for: how far, out of how many. Undefined when nothing was counted. */
function nextProgressOf(progress: { sources?: { processed?: number; total?: number; stale?: boolean; source?: string }[] } | undefined): { done: number; total: number } | undefined {
  const source = (progress?.sources ?? []).find(row => !row.stale && row.source !== "independent-verifier" && typeof row.total === "number" && row.total > 0);
  return source === undefined ? undefined : { done: Math.min(source.processed ?? 0, source.total!), total: source.total! };
}

/** How long ago, as the key of the phrase and its number. */
function nextAgo(iso: string | undefined, now: number): { key: string; n: number } {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso ?? "")) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return { key: "now", n: 0 };
  if (minutes < 60) return { key: "minutes", n: minutes };
  if (minutes < 60 * 24) return { key: "hours", n: Math.floor(minutes / 60) };
  return { key: "days", n: Math.floor(minutes / (60 * 24)) };
}

export const nextLogic = { nextStateOf, nextGroupOf, nextInboxGroupOf, nextProgressOf, nextAgo };

/** The same functions, as page source. */
export const NEXT_LOGIC_JS = [nextStateOf, nextGroupOf, nextInboxGroupOf, nextProgressOf, nextAgo].map(fn => fn.toString()).join("\n");
