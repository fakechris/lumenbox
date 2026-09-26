/**
 * The requests that put work into Feishu and DingTalk (INV-754): pure, so each shape is tested
 * against what the vendor documents rather than against a live tenant.
 *
 * Shapes checked against the vendors' own API pages on 2026-09-26 (open.feishu.cn `.md` docs,
 * open.dingtalk.com). The gotchas that decide them, kept here because each one breaks silently:
 *
 * - A document the Feishu app creates belongs to the app and is invisible to everyone else — the
 *   link alone does not open it. The person who asked has to be added as a collaborator.
 * - An event created with the app's token is on the app's calendar; a person sees it only as an
 *   attendee. A task is visible only to its assignees and followers.
 * - Three time units in one vendor: calendar timestamps are seconds as a string, task due dates are
 *   milliseconds as a string, Bitable dates are milliseconds as numbers. DingTalk takes ISO time and
 *   a zone name.
 * - A document takes at most 50 blocks per call, three edits a second: appended in order, in chunks.
 * - A newline inside a text run is a soft break; a paragraph is a new block.
 */

// ── Feishu documents ─────────────────────────────────────────────────────────────────────────

type TextElement = { text_run: { content: string } };
export type FeishuBlock =
  | { block_type: 2; text: { elements: TextElement[] } }
  | { block_type: 3; heading1: { elements: TextElement[] } }
  | { block_type: 4; heading2: { elements: TextElement[] } }
  | { block_type: 5; heading3: { elements: TextElement[] } }
  | { block_type: 12; bullet: { elements: TextElement[] } }
  | { block_type: 13; ordered: { elements: TextElement[] } }
  | { block_type: 14; code: { elements: TextElement[]; style: { language: number } } }
  | { block_type: 15; quote: { elements: TextElement[] } }
  | { block_type: 22; divider: Record<string, never> };

/** Feishu's code-language numbers for the languages worth naming; anything else is plain text. */
const CODE_LANGUAGE: Record<string, number> = {
  bash: 7, sh: 7, shell: 7, json: 28, javascript: 30, js: 30, python: 49, py: 49, typescript: 63, ts: 63,
};

export const FEISHU_BLOCKS_PER_CALL = 50;

const run = (content: string): TextElement[] => [{ text_run: { content } }];

/**
 * Markdown as Feishu document blocks: headings (# to ###), bullets, numbered items, quotes, fenced
 * code, dividers and paragraphs. Inline markup is kept as written — a faithful plain rendering is
 * better than a guessed rich one. Lines of one paragraph are joined; a blank line starts the next.
 */
export function markdownToFeishuBlocks(markdown: string): FeishuBlock[] {
  const blocks: FeishuBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ block_type: 2, text: { elements: run(paragraph.join(" ")) } });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line.trim());
    if (fence) {
      flush();
      const body: string[] = [];
      for (index += 1; index < lines.length && !/^```\s*$/.test(lines[index]!.trim()); index++) body.push(lines[index]!);
      blocks.push({ block_type: 14, code: { elements: run(body.join("\n")), style: { language: CODE_LANGUAGE[fence[1]!.toLowerCase()] ?? 1 } } });
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "") { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      const level = Math.min(heading[1]!.length, 3);
      const elements = run(heading[2]!);
      blocks.push(level === 1 ? { block_type: 3, heading1: { elements } } : level === 2 ? { block_type: 4, heading2: { elements } } : { block_type: 5, heading3: { elements } });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); blocks.push({ block_type: 22, divider: {} }); continue; }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) { flush(); blocks.push({ block_type: 12, bullet: { elements: run(bullet[1]!) } }); continue; }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) { flush(); blocks.push({ block_type: 13, ordered: { elements: run(ordered[1]!) } }); continue; }
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) { flush(); blocks.push({ block_type: 15, quote: { elements: run(quote[1]!) } }); continue; }
    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

/** Blocks in the calls that carry them, in order. */
export function chunkBlocks(blocks: readonly FeishuBlock[], size = FEISHU_BLOCKS_PER_CALL): FeishuBlock[][] {
  const chunks: FeishuBlock[][] = [];
  for (let index = 0; index < blocks.length; index += size) chunks.push(blocks.slice(index, index + size));
  return chunks;
}

/** A document's link, when the tenant's domain is known — the docs give no generic host. */
export function feishuDocUrl(documentId: string, domain: string | undefined): string | undefined {
  if (domain === undefined || domain.trim() === "") return undefined;
  const host = domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}/docx/${documentId}`;
}

// ── time ─────────────────────────────────────────────────────────────────────────────────────

/** A moment the model wrote (ISO, or "YYYY-MM-DD HH:mm" read in the zone given), as epoch ms. */
export function instantOf(text: string, timezone: string | undefined): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  // An explicit offset or Z is taken as written.
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(trimmed)) {
    const at = Date.parse(trimmed);
    return Number.isFinite(at) ? at : undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (!match) return undefined;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = match;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (timezone === undefined || timezone === "UTC") return asUtc;
  // The zone's offset at that wall time: format the UTC guess in the zone and correct by the gap.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(asUtc))
    .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - (shown - asUtc);
}

// ── Feishu calendar and tasks ────────────────────────────────────────────────────────────────

export function feishuEventBody(input: { summary: string; description?: string; startMs: number; endMs: number; timezone?: string }): Record<string, unknown> {
  const at = (ms: number) => ({ timestamp: String(Math.floor(ms / 1000)), ...(input.timezone !== undefined ? { timezone: input.timezone } : {}) });
  return {
    summary: input.summary,
    ...(input.description !== undefined && input.description !== "" ? { description: input.description } : {}),
    start_time: at(input.startMs),
    end_time: at(input.endMs),
  };
}

export function feishuTaskBody(input: { summary: string; description?: string; dueMs?: number; allDay?: boolean; assignees: readonly string[]; followers: readonly string[] }): Record<string, unknown> {
  const members = [
    ...input.assignees.map(id => ({ id, type: "user", role: "assignee" })),
    ...input.followers.filter(id => !input.assignees.includes(id)).map(id => ({ id, type: "user", role: "follower" })),
  ];
  return {
    summary: input.summary,
    ...(input.description !== undefined && input.description !== "" ? { description: input.description } : {}),
    ...(input.dueMs !== undefined ? { due: { timestamp: String(input.dueMs), is_all_day: input.allDay === true } } : {}),
    ...(members.length > 0 ? { members } : {}),
  };
}

// ── DingTalk ─────────────────────────────────────────────────────────────────────────────────

export function dingtalkEventBody(input: { summary: string; description?: string; startMs: number; endMs: number; timezone: string; attendees: readonly string[] }): Record<string, unknown> {
  const at = (ms: number) => ({ dateTime: new Date(ms).toISOString(), timeZone: input.timezone });
  return {
    summary: input.summary,
    ...(input.description !== undefined && input.description !== "" ? { description: input.description } : {}),
    start: at(input.startMs),
    end: at(input.endMs),
    ...(input.attendees.length > 0 ? { attendees: input.attendees.map(id => ({ id })) } : {}),
  };
}

/** The requester's own id on a door, from the identities their principal speaks from. */
export function doorIdOf(identities: readonly string[] | undefined, door: "feishu" | "dingtalk"): string | undefined {
  const found = identities?.find(identity => identity.startsWith(`${door}:`));
  return found?.slice(door.length + 1) || undefined;
}
