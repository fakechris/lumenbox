/**
 * Whether a wire text means markdown, shared by the adapters that can render it.
 *
 * Feishu renders markdown natively in a post's `md` element and DingTalk in its
 * `markdown` message type; the verdict decides which wire form the words travel as,
 * so a plain sentence must stay plain. The block constructs plain prose never
 * contains. Snake_case is deliberately not read as emphasis — code speaks in
 * underscores, people rarely italicize, and a false positive only changes the
 * wire form, not the words.
 *
 * One copy here because two was one too many: DingTalk's first markdown pass
 * drifted from Feishu's within weeks of both existing.
 */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s+\S/m.test(text) ||
    /```/.test(text) ||
    /`[^`\n]+`/.test(text) ||
    /^\s*[-*+]\s+\S/m.test(text) ||
    /^\s*\d+\.\s+\S/m.test(text) ||
    /^\s*>/m.test(text) ||
    /\*\*[^*\n]+\*\*/.test(text) ||
    /^\s*\|.*\|\s*$/m.test(text) ||
    /\[[^\]\n]+\]\([^)\n]+\)/.test(text)
  );
}
