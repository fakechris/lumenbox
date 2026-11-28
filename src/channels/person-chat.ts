/**
 * A chat key that addresses a person instead of a conversation (INV-2221, docs/109 §4).
 *
 * Everything that sends on the host's initiative is keyed by a chat: the speaking right, the
 * outbox and its receipts, the daily allowance, the record of what was sent. A conversation's key
 * exists only once somebody has written in it, so an agent whose person never wrote to the bot had
 * no key and therefore no way to say anything. This is the key for that case: `<door>:@<subject>`,
 * the person's direct chat with the door's bot, which the vendor opens when the bot writes first
 * (DingTalk: the robot's one-to-one send by user id; Feishu: a message to an open_id). No real
 * conversation id starts with `@`, so a door tells the two apart by the first character.
 */

/** The key of `identity`'s direct chat with its door's bot. `identity` is `<door>:<subject>`. */
export function personChatKey(identity: string): string | undefined {
  const at = identity.indexOf(":");
  return at <= 0 || at === identity.length - 1 ? undefined : `${identity.slice(0, at)}:@${identity.slice(at + 1)}`;
}

/** The subject a person's key addresses (a DingTalk user id, a Feishu open_id); undefined for a conversation's key. */
export function personOfChatKey(chatKey: string): string | undefined {
  const address = chatKey.slice(chatKey.indexOf(":") + 1);
  return chatKey.includes(":") && address.startsWith("@") && address.length > 1 ? address.slice(1) : undefined;
}

/**
 * A send that writes to a person first. A vendor's refusal (a 4xx that is not rate limiting: the
 * app may not start one-to-one chats, the person is outside its range) is worded so the outbox
 * reads it as a verdict (`conversationGone`): recorded once, shown with the other delivery
 * problems, not retried. Anything else is thrown as it came, and is tried again as any send is.
 */
export async function writingFirst(send: () => Promise<void>): Promise<void> {
  try { await send(); } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw /^(?:HTTP )?4(?!29)\d\d\b/.test(detail) ? new Error(`no permission to write to this person first (${detail})`) : error;
  }
}
