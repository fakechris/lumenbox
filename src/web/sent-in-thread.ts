/**
 * What a chat was sent that the transcript does not say, put where it happened (INV-1841).
 *
 * A thread on the page is drawn from the agent's transcript. A chat also receives things no transcript
 * holds: the acknowledgement while a long request runs, a card, a file, the screenshot at the end, the
 * host's own notices. Somebody reading the page beside the chat saw messages on one side with nothing
 * across from them. Here each of those becomes a row at its time. What the transcript already says —
 * the opening line, the reply — is the bubble it already is and is not repeated.
 */

import type { SentRow } from "../channels/sent-ledger.ts";
import type { DisplayEntry } from "./transcript.ts";

/** Enough of a text to know it again: sends are cut, cleaned and suffixed on their way out. */
const head = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 120);

export function withSent(display: readonly DisplayEntry[], rows: readonly SentRow[]): DisplayEntry[] {
  if (rows.length === 0) return [...display];
  const said = display.flatMap(entry => entry.kind === "text" && entry.role === "assistant" ? [head(entry.text)] : []).filter(text => text !== "");
  const extra = rows
    .filter(row => row.kind !== "text" || (head(row.text ?? "") !== "" && !said.some(text => text.startsWith(head(row.text ?? "")) || head(row.text ?? "").startsWith(text))))
    .sort((a, b) => a.at.localeCompare(b.at));
  const out: DisplayEntry[] = [];
  let next = 0;
  const place = (before?: string) => {
    while (next < extra.length && (before === undefined || extra[next]!.at < before)) {
      const row = extra[next++]!;
      out.push({ kind: "sent", what: row.kind, door: row.door, at: row.at, ...(row.card ? { card: row.card } : {}), ...(row.text ? { text: row.text } : {}), ...(row.name ? { name: row.name } : {}) });
    }
  };
  for (const entry of display) {
    // Placed before what a person said next, never between an agent's steps and its reply.
    if (entry.kind === "text" && entry.role === "user" && typeof entry.at === "string") place(entry.at);
    out.push(entry);
  }
  place();
  return out;
}
