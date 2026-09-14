/** Feishu against the adapter contract (INV-129): the real receiver, the socket scripted. */

import { FeishuChannel } from "./feishu.ts";
import { runAdapterContract, settle, type ContractEvent } from "./contract.ts";
import type { InboundMessage } from "./manager.ts";

runAdapterContract({
  adapterClass: "FeishuChannel",
  prefix: "feishu",
  capabilities: { chatKey: true, threads: true, messageId: true, mentions: true, duplicateSameId: "drop", duplicateDifferentContent: "drop-as-different", identityIsChat: false },
  async make() {
    const dropped: string[] = [];
    const inbound: InboundMessage[] = [];
    const adapter = new FeishuChannel("app", "secret", line => dropped.push(line));
    const internals = adapter as unknown as { ownOpenIdCache?: string; sendToChat: unknown; receiverFor: (h: (m: InboundMessage) => Promise<string | undefined>) => (data: unknown) => unknown };
    internals.ownOpenIdCache = "ou_bot";
    internals.sendToChat = async () => undefined;
    const receive = internals.receiverFor(async message => {
      inbound.push(message);
      return undefined;
    });
    const data = (event: ContractEvent) => {
      if (event.kind === "no-sender") {
        return { message: { message_id: event.id, chat_id: event.chat, message_type: "text", content: JSON.stringify({ text: event.text }), chat_type: "group" } };
      }
      if (event.kind === "unknown") {
        return { sender: { sender_id: { open_id: event.sender } }, message: { message_id: event.id, chat_id: event.chat, message_type: "sticker", content: "{}", chat_type: "group" } };
      }
      return {
        sender: { sender_id: { open_id: event.sender } },
        message: {
          message_id: event.id,
          chat_id: event.chat,
          message_type: "text",
          content: JSON.stringify({ text: event.mention ? `@_user_1 ${event.text}` : event.text }),
          chat_type: event.group ? "group" : "p2p",
          ...(event.mention ? { mentions: [{ id: { open_id: "ou_bot" }, key: "@_user_1" }] } : {}),
          ...(event.thread !== undefined ? { thread_id: event.thread, root_id: "om_root" } : {}),
        },
      };
    };
    return {
      async deliver(event) {
        receive(data(event));
        await settle();
      },
      inbound: () => inbound,
      dropped: () => dropped,
    };
  },
});
