/** Select a reply by causal identity, never by when a queued request arrived. */
export function replyForMessage(entries: readonly unknown[], messageId: string): string {
  const records = entries as readonly { role?: string; kind?: string; text?: string; turnId?: string; causedBy?: readonly string[]; host?: true }[];
  const turns = new Set(records.filter(entry => entry.role === "user" && entry.causedBy?.includes(messageId) && entry.turnId !== undefined).map(entry => entry.turnId));
  // A host-authored line (the empty-output note, INV-775) is for the record, not a reply.
  return records.filter(entry => entry.role === "assistant" && entry.kind === undefined && entry.host !== true && entry.turnId !== undefined && turns.has(entry.turnId) && entry.text)
    .map(entry => entry.text!).join("\n\n");
}

/**
 * Whether the turn a message opened ended in deliberate silence — `NothingToSay` was called — and
 * why (INV-775). Selected by the same causal identity as `replyForMessage`, so a queued neighbour's
 * silence is never mistaken for this message's (INV-801).
 */
export function silenceForMessage(entries: readonly unknown[], messageId: string): { silent: { reason: string } } | undefined {
  const records = entries as readonly { role?: string; kind?: string; turnId?: string; causedBy?: readonly string[]; silent?: { reason: string } }[];
  const turns = new Set(records.filter(entry => entry.role === "user" && entry.causedBy?.includes(messageId) && entry.turnId !== undefined).map(entry => entry.turnId));
  const entry = records.find(entry => entry.silent !== undefined && entry.turnId !== undefined && turns.has(entry.turnId));
  return entry?.silent === undefined ? undefined : { silent: entry.silent };
}
