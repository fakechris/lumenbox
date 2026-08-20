/**
 * Reading a Range header.
 *
 * Its own module rather than a helper inside main.ts, because importing main.ts starts the daemon —
 * it refuses to load without a token — so nothing pure in there can be tested directly.
 */

/**
 * Which bytes a Range header asks for, or `undefined` when it asks for none.
 *
 * The suffix form was read backwards: `bytes=-1024` means *the last* 1024 bytes, and this returned
 * the first 1025 while labelling them `0-1024` in Content-Range. A video client asking for the tail
 * to find an MP4's moov atom got the head instead, so seeking and duration probing failed on a file
 * that was perfectly fine.
 */
export function resolveRange(
  header: string | undefined,
  total: number
): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!match) return undefined;
  const from = match[1];
  const to = match[2];
  // Neither side given is not a range at all.
  if (!from && !to) return "unsatisfiable";

  const { start, end } = from
    ? { start: Number(from), end: to ? Math.min(Number(to), total - 1) : total - 1 }
    : // Suffix: the last N bytes, clamped to the whole file when N is larger than it.
      { start: Math.max(0, total - Number(to)), end: total - 1 };

  if (start > end || start >= total || start < 0) return "unsatisfiable";
  return { start, end };
}
