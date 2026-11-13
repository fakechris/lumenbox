/**
 * What the person is told when a gate sent the answer back first (INV-1841).
 *
 * Three gates hold a finished answer before it is delivered and ask for it again: the quote check, the
 * check on files about to be posted, and the look at a message that arrived meanwhile. The draft is
 * filed where no reply is read from, on the understanding that the next text replaces it.
 *
 * On 2026-10-21 it did not. An agent wrote a 1,400-character answer, the quote check sent it back, the
 * agent fixed one sentence in a file and said so in ninety characters — and that note was the reply. The
 * chat received "已改：那个引号里的句子是我自己的措辞…" about an answer nobody had been shown. Measured on a
 * copy of the live record: the host spoke inside 27 of 246 chat requests.
 *
 * A model asked to "give the answer again" answers the reviewer. So the host decides: a closing text much
 * shorter than the draft it follows is a note about the draft, and the person gets both, the draft first.
 * The wording of the request is tightened as well, but the delivery does not depend on it being obeyed.
 */

/** Said with every send-back: the model otherwise assumes its draft was read. */
export const NOT_YET_SEEN =
  "The person has not seen what you just wrote. Give the whole answer again, corrected — not a note about what you changed.";

/** The reply after a send-back: the closing text, with the draft it leaves out put back in front of it. */
export function answerAfterSendBack(draft: string | undefined, closing: string): string {
  const kept = draft?.trim() ?? "", said = closing.trim();
  if (kept === "" || said === "" || said.length * 2 >= kept.length) return closing;
  return `${kept}\n\n${said}`;
}
