/**
 * Tests for being able to say which message caused which turn.
 *
 * The point is narrower than it sounds, and the narrowness is the design. Every agent here runs in
 * one process against one clock, so ordering was never missing — timestamps already put events in
 * order. What was missing is the *link*: a turn held no trace of what set it off, and a sent message
 * held no trace of the turn that sent it, so "who caused this" could not be walked backwards
 * however precisely everything was timed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBus } from "../agents/bus.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { runTurn } from "./turn.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-cause-"));
  return {
    registry: new AgentRegistry(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a message is identified, and both ends are told the same id", () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const rex = registry.create({ name: "Rex" });
    let delivered: readonly { id: string; text: string }[] = [];
    const bus = new AgentBus(registry, async (_agent, inbound) => {
      delivered = inbound.map(message => ({ id: message.id, text: message.text }));
    });

    // The sender's acknowledgement names the message, so its own transcript — which holds this text
    // as a tool result — records which message it sent.
    const ack = bus.send({ fromId: ada.id, toId: rex.id, text: "have a look at the logs" });
    const named = /message ([0-9a-f-]{36})/.exec(ack);
    assert.ok(named, `the acknowledgement should name the message, got: ${ack}`);

    return bus.wake(rex.id).then(() => {
      // And the recipient was given that same message.
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0]?.id, named[1]);
    });
  } finally {
    cleanup();
  }
});

test("every message has an id, including the user's", () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const seen: string[] = [];
    const bus = new AgentBus(registry, async (_agent, inbound) => {
      for (const message of inbound) seen.push(message.id);
    });

    bus.sendFromUser(ada.id, "one");
    bus.sendFromUser(ada.id, "two");
    return bus.wake(ada.id).then(() => {
      assert.equal(seen.length, 2);
      assert.notEqual(seen[0], seen[1], "two messages are two things, not one");
      for (const id of seen) assert.match(id, /^[0-9a-f-]{36}$/);
    });
  } finally {
    cleanup();
  }
});


test("a turn records the messages that caused it", async () => {
  // The other half of the link, and the one that makes it walkable: given a turn that went wrong,
  // the ids in its opening entry lead back to the acknowledgements in other agents' transcripts.
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const capture: { params: unknown[] } = { params: [] };
    const client = {
      messages: {
        stream() {
          return {
            on() {
              return this;
            },
            finalMessage: async () => ({
              id: "m",
              type: "message",
              role: "assistant",
              model: "claude-opus-5",
              content: [{ type: "text", text: "done" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            }),
          };
        },
      },
    } as never;
    void capture;

    await runTurn(
      ada,
      [
        { id: "msg-1", fromId: "user", fromName: "user", text: "first", priority: false, receivedAt: "" },
        { id: "msg-2", fromId: "user", fromName: "user", text: "second", priority: false, receivedAt: "" },
      ],
      new AbortController().signal,
      { client, registry, bus, box: undefined, resolution: undefined }
    );

    const opening = (registry.readTranscript(ada.id) as { causedBy?: string[] }[]).find(
      entry => entry.causedBy !== undefined
    );
    assert.deepEqual(opening?.causedBy, ["msg-1", "msg-2"]);
  } finally {
    cleanup();
  }
});
