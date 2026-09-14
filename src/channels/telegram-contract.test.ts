/** Telegram against the adapter contract (INV-129): updates through inboundOf, no network. */

import { TelegramChannel } from "./telegram.ts";
import { runAdapterContract, type ContractEvent } from "./contract.ts";
import type { InboundMessage } from "./manager.ts";

runAdapterContract({
  adapterClass: "TelegramChannel",
  prefix: "telegram",
  // The chat is the identity and the conversation; getUpdates delivers each update once
  // by offset, so there is nothing to dedupe and no way to say who was named.
  capabilities: { chatKey: false, threads: false, messageId: true, mentions: false, duplicateSameId: "deliver", duplicateDifferentContent: "deliver", identityIsChat: true },
  renderChat: id => String(Number(id.replace(/\D/g, "")) || 1),
  async make() {
    const dropped: string[] = [];
    const inbound: InboundMessage[] = [];
    const adapter = new TelegramChannel("token", line => dropped.push(line));
    let n = 0;
    return {
      async deliver(event: ContractEvent) {
        n += 1;
        const chat = { id: Number(event.chat.replace(/\D/g, "")) || 1 };
        const update =
          event.kind === "unknown"
            ? { update_id: n, message: { message_id: Number(event.id.replace(/\D/g, "")), chat, from: { username: event.sender } } }
            : event.kind === "no-sender"
              ? { update_id: n, message: { message_id: Number(event.id.replace(/\D/g, "")), chat, text: event.text } }
              : { update_id: n, message: { message_id: Number(event.id.replace(/\D/g, "")), chat, from: { username: event.sender }, text: event.text } };
        const message = adapter.inboundOf(update);
        if (message?.messageId !== undefined) message.messageId = event.id;
        if (message !== undefined) inbound.push(message);
      },
      inbound: () => inbound,
      dropped: () => dropped,
    };
  },
});
