/**
 * The contract every channel adapter's inbound seam must meet (INV-129).
 *
 * Each adapter used to test itself, in its own words, and a routing bug fixed in one
 * door was still open in the next. This is the shared half: one set of cases, run by
 * each adapter's contract test against its real normalize/dispatch seam with the wire
 * scripted, so a message that reaches the bus from any door carries the same identity,
 * chat and thread shape, and a duplicate, an unknown event or a message with no sender
 * is handled the way the others handle it.
 *
 * Capabilities are declared, not discovered: a door that has no threads says so and
 * the thread case asserts "no threadKey", rather than being skipped and reading as a
 * pass. A door that does not dedupe says so and the duplicate case asserts two
 * deliveries — the truth, on record, until someone changes it.
 *
 * `CONTRACTED_ADAPTERS` is the roll call. contract-registry.test.ts reads the source
 * tree: every class that implements ChannelAdapter must be listed here and driven by
 * a test that names it, so a new door without a contract fails the suite, not the user.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { InboundMessage } from "./manager.ts";

/** Every adapter class under contract, by class name. Add here and write its contract test. */
export const CONTRACTED_ADAPTERS = ["FeishuChannel", "DingTalkChannel", "TelegramChannel"] as const;

export interface AdapterCapabilities {
  /** `chatKey` is set and distinct from the identity in a group. */
  chatKey: boolean;
  /** `threadKey` is set, and differs between a topic and the chat root. */
  threads: boolean;
  /** `messageId` carries the wire's id. */
  messageId: boolean;
  /** `addressed` says whether a group message named the bot. */
  mentions: boolean;
  /** A second delivery of the same id: dropped and said, or delivered again. */
  duplicateSameId: "drop" | "deliver";
  /** The same id delivered with different content: dropped as different, dropped, or delivered. */
  duplicateDifferentContent: "drop-as-different" | "drop" | "deliver";
  /** The chat is the identity (Telegram): a message with no sender field is still somebody's. */
  identityIsChat: boolean;
}

export type ContractEvent =
  | { kind: "text"; id: string; sender: string; chat: string; text: string; group: boolean; thread?: string; mention?: boolean }
  | { kind: "unknown"; id: string; sender: string; chat: string }
  | { kind: "no-sender"; id: string; chat: string; text: string };

export interface ContractSubject {
  /** The class under contract, as listed in CONTRACTED_ADAPTERS. */
  adapterClass: (typeof CONTRACTED_ADAPTERS)[number];
  /** The identity prefix the adapter uses: `feishu`, `dingtalk`, `telegram`. */
  prefix: string;
  capabilities: AdapterCapabilities;
  /** How this door spells a chat id in an identity or chatKey, when it is not the raw string (Telegram: a number). */
  renderChat?: (chat: string) => string;
  /** A fresh adapter with every wire scripted; called once per case. */
  make(): Promise<{
    /** Delivers one synthetic vendor event through the real seam; resolves once the bus has heard it or the door has decided not to say. */
    deliver(event: ContractEvent): Promise<void>;
    /** What reached the bus so far. */
    inbound(): InboundMessage[];
    /** What the door logged or recorded as dropped so far. */
    dropped(): string[];
  }>;
}

/** Runs the contract as node:test cases; each adapter's contract test calls this once. */
export function runAdapterContract(subject: ContractSubject): void {
  const { prefix, capabilities: can } = subject;
  const label = `${subject.adapterClass} contract`;
  const chat = (id: string) => subject.renderChat?.(id) ?? id;

  test(`${label}: identity is the sender, the chat is the room, the id is the wire's`, async () => {
    const door = await subject.make();
    await door.deliver({ kind: "text", id: "m1", sender: "u1", chat: "c1", text: "hello", group: true, mention: true });
    const [message] = door.inbound();
    assert.ok(message !== undefined, "a plain text message reaches the bus");
    assert.equal(message.identity, can.identityIsChat ? `${prefix}:${chat("c1")}` : `${prefix}:u1`);
    assert.ok(message.senderLabel !== "", "a label for the activity feed");
    assert.equal(message.text.trim() !== "", true);
    if (can.chatKey) assert.equal(message.chatKey, `${prefix}:${chat("c1")}`);
    else assert.equal(message.chatKey, undefined, "a door without rooms offers no chatKey");
    if (can.messageId) assert.equal(message.messageId, "m1");
  });

  test(`${label}: a topic is its own conversation${can.threads ? "" : " — declared absent on this door"}`, async () => {
    const door = await subject.make();
    await door.deliver({ kind: "text", id: "m2", sender: "u1", chat: "c1", text: "root", group: true, mention: true });
    await door.deliver({ kind: "text", id: "m3", sender: "u1", chat: "c1", text: "in a topic", group: true, mention: true, thread: "t1" });
    const [root, topic] = door.inbound();
    assert.ok(root !== undefined && topic !== undefined);
    if (can.threads) {
      assert.ok(topic.threadKey !== undefined, "a topic message names its thread");
      assert.notEqual(topic.threadKey, root.threadKey, "and it is not the chat root's");
    } else {
      assert.equal(root.threadKey, undefined);
      assert.equal(topic.threadKey, undefined);
    }
  });

  test(`${label}: the same id twice is ${can.duplicateSameId === "drop" ? "one turn, and the drop is said" : "delivered twice — declared on this door"}`, async () => {
    const door = await subject.make();
    const event: ContractEvent = { kind: "text", id: "m4", sender: "u1", chat: "c1", text: "again", group: true, mention: true };
    await door.deliver(event);
    await door.deliver(event);
    if (can.duplicateSameId === "drop") {
      assert.equal(door.inbound().length, 1);
      assert.ok(door.dropped().some(line => /delivered more than once|already/.test(line)), `the drop is on record: ${door.dropped().join(" | ")}`);
    } else {
      assert.equal(door.inbound().length, 2);
    }
  });

  test(`${label}: the same id with different content is ${can.duplicateDifferentContent === "deliver" ? "delivered — declared on this door" : "not a second turn"}`, async () => {
    const door = await subject.make();
    await door.deliver({ kind: "text", id: "m5", sender: "u1", chat: "c1", text: "first words", group: true, mention: true });
    await door.deliver({ kind: "text", id: "m5", sender: "u1", chat: "c1", text: "other words", group: true, mention: true });
    if (can.duplicateDifferentContent === "deliver") {
      assert.equal(door.inbound().length, 2);
    } else {
      assert.equal(door.inbound().length, 1, "one turn");
      const said = door.dropped().join(" | ");
      if (can.duplicateDifferentContent === "drop-as-different") assert.match(said, /different content/);
      else assert.match(said, /delivered more than once|already/);
    }
  });

  test(`${label}: a group message ${can.mentions ? "says whether the bot was named" : "cannot say whether the bot was named — declared"}`, async () => {
    const door = await subject.make();
    await door.deliver({ kind: "text", id: "m6", sender: "u1", chat: "c1", text: "nobody in particular", group: true, mention: false });
    await door.deliver({ kind: "text", id: "m7", sender: "u1", chat: "c1", text: "you there", group: true, mention: true });
    const [unnamed, named] = door.inbound();
    assert.ok(unnamed !== undefined && named !== undefined, "both reach the bus; the manager decides what to do with an unaddressed one");
    if (can.mentions) {
      assert.equal(unnamed.addressed, false);
      assert.equal(named.addressed, true);
    } else {
      assert.equal(unnamed.addressed, undefined);
      assert.equal(named.addressed, undefined);
    }
  });

  test(`${label}: an event of a kind this door does not handle reaches nobody, and does not throw`, async () => {
    const door = await subject.make();
    await door.deliver({ kind: "unknown", id: "m8", sender: "u1", chat: "c1" });
    assert.equal(door.inbound().length, 0);
    assert.ok(door.dropped().length > 0, "and the door says it dropped something");
  });

  test(`${label}: a message with no sender is ${can.identityIsChat ? "the chat's own — declared on this door" : "dropped and said, never admitted under a made-up identity"}`, async () => {
    const door = await subject.make();
    await door.deliver({ kind: "no-sender", id: "m9", chat: "c1", text: "who said this" });
    if (can.identityIsChat) {
      assert.equal(door.inbound()[0]?.identity, `${prefix}:${chat("c1")}`);
      return;
    }
    assert.equal(door.inbound().length, 0, `nothing reaches the bus; got ${JSON.stringify(door.inbound().map(m => m.identity))}`);
    assert.ok(door.dropped().some(line => /sender|identity/.test(line)), `the reason names the missing sender: ${door.dropped().join(" | ")}`);
  });
}

/** Waits for the door's fire-and-forget dispatch to land on the bus. */
export const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 15));
