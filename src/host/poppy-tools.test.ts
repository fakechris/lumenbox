import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { POPPY_TOOLS, dispatchPoppyTool, poppyToolDefinitions, type PoppyToolContext } from "./poppy-tools.ts";

// The tools against a real manager on a scripted network are in poppy/protocol.test.ts; this is the table itself.
const notReady = { ready: false } as unknown as PoppyToolContext["manager"];

describe("the Poppy tools", () => {
  test("four, and POPPY_TOOLS names exactly them", () => {
    assert.deepEqual(new Set(poppyToolDefinitions().map(tool => tool.name)), POPPY_TOOLS);
  });

  test("PoppyRequest tells the model where it may go and what it may not do", () => {
    const request = poppyToolDefinitions().find(tool => tool.name === "PoppyRequest")!;
    assert.match(request.description ?? "", /only to its destinations/);
    assert.match(request.description ?? "", /continue_url/);
    assert.match(request.description ?? "", /never approve or retry it yourself/);
  });

  test("refused plainly before the identity exists, and for a name that is not a Poppy tool", async () => {
    const ctx: PoppyToolContext = { manager: notReady, who: "ada", conversation: "main" };
    assert.match((await dispatchPoppyTool("PoppyDiscover", { domain: "x.example" }, ctx)).text, /not available/);
    const ready = { ...ctx, manager: { ready: true } as unknown as PoppyToolContext["manager"] };
    assert.match((await dispatchPoppyTool("PoppyFoo", {}, ready)).text, /Unknown Poppy tool/);
  });
});
