/** DingTalk against the adapter contract (INV-129): real frames through receive(), the wire scripted. */

import { DingTalkChannel, TOPIC } from "./dingtalk.ts";
import { runAdapterContract, type ContractEvent } from "./contract.ts";
import type { InboundMessage } from "./manager.ts";

runAdapterContract({
  adapterClass: "DingTalkChannel",
  prefix: "dingtalk",
  capabilities: { chatKey: true, threads: false, messageId: true, mentions: false, duplicateSameId: "drop", duplicateDifferentContent: "drop", identityIsChat: false },
  async make() {
    const dropped: string[] = [];
    const inbound: InboundMessage[] = [];
    const adapter = new DingTalkChannel("app", "secret", line => dropped.push(line));
    (adapter as unknown as { transmit: unknown }).transmit = async () => undefined;
    (adapter as unknown as { downloadResource: unknown }).downloadResource = async () => ({});
    let frames = 0;
    const frame = (event: ContractEvent) => {
      frames += 1;
      const base = { conversationId: event.chat, conversationType: "2", msgId: event.id, sessionWebhook: "https://hook.test/x" };
      const payload =
        event.kind === "no-sender"
          ? { ...base, msgtype: "text", text: { content: event.text } }
          : event.kind === "unknown"
            ? { ...base, senderStaffId: event.sender, senderNick: "U", msgtype: "unknownKind" }
            : { ...base, senderStaffId: event.sender, senderNick: "U", msgtype: "text", text: { content: event.text }, isInAtList: event.mention };
      return JSON.stringify({ type: "CALLBACK", headers: { topic: TOPIC, messageId: `tr-${frames}` }, data: JSON.stringify(payload) });
    };
    return {
      async deliver(event) {
        await adapter.receive(frame(event), { respond: () => {} }, async message => {
          inbound.push(message);
          return undefined;
        });
      },
      inbound: () => inbound,
      dropped: () => dropped,
    };
  },
});
