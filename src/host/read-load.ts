/**
 * How much a turn has read, told to the model once (INV-1222).
 *
 * When to hand work to a Fork or a Delegate was the model's call on no numbers: the tool
 * descriptions say "heavy", and the context fills until compaction. The host has the numbers —
 * characters of tool results this turn, tool rounds, the request's size against the model's
 * compaction trigger — and here they become one host note at the moment they say "this is
 * getting heavy". A signal, not a hand on the wheel: the model still decides (rails, not hands).
 *
 * Thresholds are constants, not settings, and come from this installation's own ledger on
 * 2026-10-20 (358 turns, read-only statistics, docs/16 §"The read-load signal"): a turn's
 * context grew by a median 4.3k tokens and a p90 of 28.6k; 120k characters of results is about
 * that p90 at four characters a token. Sixty percent of the trigger is where a turn still has
 * room to split its work before compaction takes the room away.
 */

export const READ_LOAD_CHARS = 120_000;
export const READ_LOAD_SHARE = 0.6;

/** The tools whose results are reading: material brought in, not work done. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "ReadHistory",
  "ReadKept",
  "Recall",
  "WebFetch",
  "WebSearch",
  "ReadFeishuDoc",
  "browser_read",
  "browser_snapshot",
  "Jobs",
  "OtherThreads",
]);

export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}

export interface ReadLoad {
  /** Characters of tool results so far this turn. */
  chars: number;
  /** Rounds that called at least one tool. */
  toolRounds: number;
  /** The last request's estimated size over the compaction trigger, 0–1+. */
  share: number;
  /** Whether this round's calls were reading. */
  reading: boolean;
}

/** Crossed when the results alone are a lot, or the context is most of the way to compaction and the turn is still reading. */
export function readLoadCrossed(load: ReadLoad): boolean {
  return load.chars > READ_LOAD_CHARS || (load.share > READ_LOAD_SHARE && load.reading);
}

/**
 * Whether this round gets the note: crossed, not yet told this turn, and a turn the note is
 * for — not a fork's (a fork exists to be heavy and disposable), not a goal continuation
 * (the goal loop paces those itself).
 */
export function readLoadNudgeDue(load: ReadLoad, turn: { nudged: boolean; fork: boolean; goal: boolean }): boolean {
  return !turn.nudged && !turn.fork && !turn.goal && readLoadCrossed(load);
}

/** The note, in the person's language; one per turn, appended to the round's results. */
export function readLoadNudge(load: ReadLoad, chinese: boolean): string {
  const percent = Math.round(load.share * 100);
  const thousands = Math.round(load.chars / 1_000);
  if (chinese) {
    return (
      `[宿主提示] 这一轮到现在已经读进来约 ${thousands}k 字符的工具结果（${load.toolRounds} 轮工具调用），` +
      `上下文约为压缩触发线的 ${percent}%。剩下的工作里，凡是能独立完成、只需要交回结论的部分，` +
      `请交给 Fork 并设 background: true；如果是在一个仓库里要读很多文件、反复改和测的深度工作，交给 Delegate。` +
      `你仍然自己决定；这条提示每轮只出现一次。`
    );
  }
  return (
    `[host] This turn has read about ${thousands}k characters of tool results so far (${load.toolRounds} tool rounds); ` +
    `the context is at about ${percent}% of the compaction trigger. Hand the parts of what remains that can be done ` +
    `on their own and reported back to Fork with background: true; for deep work inside a repository — many files ` +
    `read, edited and tested in a loop — hand it to Delegate. Your call; this note appears once per turn.`
  );
}
