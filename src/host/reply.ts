/** Select a reply by causal identity, never by when a queued request arrived. */
export function replyForMessage(entries: readonly unknown[], messageId: string): string {
  const records = entries as readonly { role?: string; kind?: string; text?: string; turnId?: string; causedBy?: readonly string[] }[];
  const turns = new Set(records.filter(entry => entry.role === "user" && entry.causedBy?.includes(messageId) && entry.turnId !== undefined).map(entry => entry.turnId));
  return records.filter(entry => entry.role === "assistant" && entry.kind === undefined && entry.turnId !== undefined && turns.has(entry.turnId) && entry.text)
    .map(entry => entry.text!).join("\n\n");
}
