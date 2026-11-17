/**
 * The last thing an agent said in a conversation, read from the end of its file (2026-11-15).
 *
 * Bob works almost only in Feishu topics. Opening him on the page showed his main conversation, where
 * nothing of that work is, and a column of lines like "2 unread in another conversation": the person
 * could see that something had happened and not what. A conversation row now carries the agent's last
 * reply beside the question that opened it, so the topics can be read from the agent's page.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

// Enough for a long answer in Chinese (three bytes a character): the page shows the reply whole, as it was written.
const TAIL_BYTES = 98_304, REPLY_CHARS = 8_000;

export function lastReply(path: string): { text: string; at?: string; cut?: true } | undefined {
  if (!existsSync(path)) return undefined;
  let tail = "";
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES), buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      tail = buffer.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return undefined; }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { role?: string; kind?: string; text?: string; at?: string; host?: true };
    try { entry = JSON.parse(lines[i]!); } catch { continue; } // the first line of the window may be cut
    if (entry.role !== "assistant" || entry.kind !== undefined || entry.host === true || typeof entry.text !== "string" || entry.text.trim() === "") continue;
    const text = entry.text.trim();
    return { text: text.slice(0, REPLY_CHARS), ...(text.length > REPLY_CHARS ? { cut: true as const } : {}), ...(entry.at !== undefined ? { at: entry.at } : {}) };
  }
  return undefined;
}
