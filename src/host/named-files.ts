/**
 * Files an answer points at instead of handing over.
 *
 * An agent finished a piece of research, wrote it to
 * `/home/box/work/skills/financial-statement-parsing/SKILL.md`, and replied "the full
 * version is at «that path»". Inside the box that is a real file. To the person reading
 * the reply in a chat it is a string they cannot open, and they had to ask again.
 *
 * The outbox convention exists for exactly this and the prompt describes it, so the first
 * instinct is to say it harder. But this is not a judgement about meaning — it is a path,
 * a directory listing, and a comparison — which puts it on the harness's side of the line
 * this codebase keeps drawing: **deterministic code where the model provably slips, and
 * only there.** The model decides what to write and what to say; whether the thing it
 * named actually reached the person is checkable, so it gets checked.
 *
 * Deliberately additive. Nothing here rewrites the reply or stops it: the file is sent
 * alongside, and the answer still reads as the agent wrote it.
 */

/**
 * Absolute box paths a reply names, in the order they appear, deduplicated.
 *
 * Conservative on purpose. It matches a path only up to whitespace or a closing quote,
 * backtick or bracket, because a path in prose is usually fenced by one of those, and a
 * greedy match would swallow the sentence after it. Trailing punctuation is trimmed for
 * the same reason: "…at /home/box/work/x.md, below is the summary" names `x.md`.
 *
 * `work` is the box's work directory (`workDir`, box-paths.ts): paths outside it are not ours to
 * deliver. The image's `/home/box/work` on a Docker box; a host box's own (INV-1737).
 */
export function boxPathsNamed(reply: string, work: string): string[] {
  const found: string[] = [];
  const root = work.replace(/[.*+?^$()|{}[\]\\]/g, "\\$&");
  const named = new RegExp(root + "/[^\\s`'\"()<>[\\]，。、）]+", "g");
  for (const match of reply.matchAll(named)) {
    const path = match[0].replace(/[.,;:!?]+$/, "");
    // A bare directory is not a deliverable.
    if (!/\.[A-Za-z0-9]{1,8}$/.test(path)) continue;
    if (!found.includes(path)) found.push(path);
  }
  return found;
}

/**
 * Which named paths still need delivering, given what the outbox already sent.
 *
 * Compared by basename rather than by full path: the ordinary case is that the agent
 * wrote the file somewhere of its own and *also* copied it to the outbox, and sending the
 * same document twice under two paths is worse than not noticing.
 */
export function undelivered(named: readonly string[], alreadySent: readonly string[]): string[] {
  const sent = new Set(alreadySent.map(basename));
  return named.filter(path => !sent.has(basename(path)));
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}
