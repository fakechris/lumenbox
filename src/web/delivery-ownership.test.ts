/**
 * A routine reports into its own box's rooms (INV-541).
 *
 * The check Octop makes on a scheduled delivery is session ownership
 * (`delivery.py:72-75`: `session.user_id != command.user_id` raises); we had none, so a
 * routine in one box could name another box's chat and the host would push into it. The
 * rule here is narrower than "the same box or nothing", on purpose: a chat nobody has
 * driven is nobody's — naming a room the bot has never been messaged in is an ordinary
 * setup — but a chat another box's agents have been talked to in is that box's room.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, conversationIdFor } from "../agents/registry.ts";

test("a chat another box has been driven from is that box's room", () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-delivery-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  try {
    const registry = new AgentRegistry(join(home, "agents"));
    const mine = registry.create({ name: "Ada", boxId: registry.box.id }).id;
    const other = registry.attachBox({
      id: "box-other",
      name: "finance",
      kind: "attached",
      endpoint: { baseUrl: "http://127.0.0.1:1", tokenFile: join(home, "unused.token") },
      displayFloor: 1,
      workDir: "/home/box/work",
      members: "everyone",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const theirs = registry.create({ name: "Fin", boxId: other.id }).id;

    // Finance has been talked to in this room; our box has not.
    const chatKey = "feishu:oc_finance";
    const conversation = conversationIdFor(chatKey);
    registry.appendTranscript(theirs, { role: "user", text: "月底对账", at: "2026-09-10T09:00:00Z" }, conversation);

    // The rule, as the server applies it.
    const driven = (boxId: string): boolean =>
      registry.agentsIn(boxId).some(agent => registry.readTranscript(agent.id, conversation).length > 0);
    const refuse = (agentId: string): boolean => {
      const myBox = registry.boxOf(agentId).id;
      const elsewhere = registry.listBoxes().filter(box => box.id !== myBox).some(box => driven(box.id));
      return elsewhere && !driven(myBox);
    };

    assert.equal(refuse(mine), true, "our routine may not report into finance's room");
    assert.equal(refuse(theirs), false, "finance's own routine may");

    // Once our box has been talked to there too — a shared room — it is ours as well.
    registry.appendTranscript(mine, { role: "user", text: "我们也在这个群", at: "2026-09-11T09:00:00Z" }, conversation);
    assert.equal(refuse(mine), false, "a room both boxes are in is not a boundary");

    // And a room nobody has ever driven is nobody's: an ordinary new setup.
    const fresh = conversationIdFor("feishu:oc_brandnew");
    const drivenFresh = (boxId: string): boolean =>
      registry.agentsIn(boxId).some(agent => registry.readTranscript(agent.id, fresh).length > 0);
    assert.equal(registry.listBoxes().some(box => drivenFresh(box.id)), false);
  } finally {
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
