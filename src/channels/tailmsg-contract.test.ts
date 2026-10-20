/** The tailmsg door against the adapter contract (INV-129, INV-1288): letters through accept(), whois scripted. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContractEvent, runAdapterContract } from "./contract.ts";
import type { InboundMessage } from "./manager.ts";
import { TailmsgDoor } from "./tailmsg.ts";

runAdapterContract({
  adapterClass: "TailmsgDoor",
  prefix: "tailmsg",
  // The peer machine is the identity and the conversation: whois verifies the machine, and
  // the agent of theirs that wrote is only a claim. Letters have no topics and cannot name
  // anyone the way a group message does; an id seen twice is in the inbox already.
  capabilities: { chatKey: true, threads: false, messageId: true, mentions: false, duplicateSameId: "drop", duplicateDifferentContent: "drop", identityIsChat: true },
  async make() {
    const dropped: string[] = [];
    const inbound: InboundMessage[] = [];
    const door = new TailmsgDoor(
      "tailmsg",
      { allow: ["c1", "c2"], wake: { defaultMax: "now" } },
      {
        self: async () => ({ name: "self.example.ts.net", address: "127.0.0.1" }),
        whois: async ip => ({ name: ip }),
        agentKnown: () => true,
        dir: mkdtempSync(join(tmpdir(), "tailmsg-contract-")),
        log: line => dropped.push(line),
        tailnetAddress: () => true,
      }
    );
    // Not listening: the contract drives accept() directly, the way the HTTP shell does.
    (door as unknown as { self: unknown; onMessage: unknown }).self = { name: "self.example.ts.net", address: "127.0.0.1" };
    (door as unknown as { onMessage: unknown }).onMessage = async (message: InboundMessage) => {
      inbound.push(message);
      return undefined;
    };
    return {
      async deliver(event: ContractEvent) {
        const base = { v: 1, id: `${event.id}-${"x".repeat(8)}`, from: event.chat, to: "self.example.ts.net", ts: "2026-10-08T14:00:00Z", wake: "now" };
        const letter =
          event.kind === "unknown"
            ? { ...base, kind: "x".repeat(40), from_agent: event.sender }
            : event.kind === "no-sender"
              ? { ...base, text: event.text }
              : { ...base, text: event.text, from_agent: event.sender };
        const { after } = await door.accept(letter, event.chat);
        await after?.();
        for (const message of inbound) if (message.messageId === base.id) message.messageId = event.id;
      },
      inbound: () => inbound,
      dropped: () => dropped,
    };
  },
});
