/**
 * ShowUI at the host: what the catalog admits, what one call becomes on the wire, and
 * what a later process can redraw. The validation claims matter most — they are the
 * promise that the page never receives a surface it would refuse — so each refusal is
 * tested by its reason, the text the agent is handed back.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionText,
  compileSurface,
  parseActionText,
  SHOW_UI_CATALOG_ID,
  SHOW_UI_COMPONENTS,
  showUiCatalog,
  SurfaceLedger,
  type SurfaceRecord,
} from "./show-ui.ts";
import { dispatchTool, PERSON_FACING_TOOLS, FORK_WITHHELD_TOOLS } from "./tools.ts";

const card = [
  { id: "root", component: "Column", children: ["title", "pick"] },
  { id: "title", component: "Text", text: "Which plan?", variant: "h3" },
  { id: "pick", component: "Button", child: "pick-label", action: { event: { name: "pick", context: { choice: "a" } } } },
  { id: "pick-label", component: "Text", text: "Plan A" },
];

test("the catalog is the named subset of the basic catalog, and nothing more", () => {
  const catalog = showUiCatalog();
  assert.equal(catalog.id, SHOW_UI_CATALOG_ID);
  const names = [...catalog.components.keys()].sort();
  assert.deepEqual(names, [...SHOW_UI_COMPONENTS].sort());
  assert.ok(!names.includes("Image") && !names.includes("Video"), "nothing that carries an external URL");
  assert.ok(names.includes("Table") && names.includes("Tabs"), "lumenbox's own and the wider basic set (INV-1280)");
});

test("a first call creates the surface; the same surface again only updates it; close deletes it", () => {
  const first = compileSurface({ surface: "s1", components: card }, undefined);
  assert.ok(first.ok, first.ok ? "" : first.reason);
  assert.deepEqual(first.send.map(message => Object.keys(message)[1]), ["createSurface", "updateComponents"]);
  const existing: SurfaceRecord = { agentId: "a1", agentName: "Ada", conversation: "main", surfaceId: "s1", messages: first.full, at: "t" };
  const again = compileSurface({ surface: "s1", components: card, data: { choice: "a" } }, existing);
  assert.ok(again.ok, again.ok ? "" : again.reason);
  assert.deepEqual(again.send.map(message => Object.keys(message)[1]), ["updateComponents", "updateDataModel"]);
  assert.equal(again.full.length, 3, "the full list still starts with createSurface");
  const closed = compileSurface({ surface: "s1", close: true }, existing);
  assert.ok(closed.ok && closed.send.length === 1 && "deleteSurface" in closed.send[0]! && closed.full.length === 0);
  const nothing = compileSurface({ surface: "s9", close: true }, undefined);
  assert.ok(!nothing.ok && /no card "s9"/.test(nothing.reason));
});

test("what the catalog refuses, with the reason the agent reads", () => {
  const outside = compileSurface({ surface: "s", components: [{ id: "root", component: "Image", url: "https://x/y.png" }] }, undefined);
  assert.ok(!outside.ok && /"Image" \(root\) is not in the catalog/.test(outside.reason), outside.ok ? "" : outside.reason);
  const unknownProperty = compileSurface({ surface: "s", components: [{ id: "root", component: "Text", text: "hi", colour: "red" }] }, undefined);
  assert.ok(!unknownProperty.ok && /colour/.test(unknownProperty.reason), unknownProperty.ok ? "" : unknownProperty.reason);
  const dangling = compileSurface({ surface: "s", components: [{ id: "root", component: "Column", children: ["ghost"] }] }, undefined);
  assert.ok(!dangling.ok && /ghost/.test(dangling.reason), dangling.ok ? "" : dangling.reason);
  const noRoot = compileSurface({ surface: "s", components: [{ id: "top", component: "Text", text: "hi" }] }, undefined);
  assert.ok(!noRoot.ok && /id "root"/.test(noRoot.reason));
  const local = compileSurface(
    { surface: "s", components: [{ id: "root", component: "Button", child: "l", action: { functionCall: { call: "openUrl", args: {} } } }, { id: "l", component: "Text", text: "go" }] },
    undefined
  );
  assert.ok(!local.ok && /openUrl/.test(local.reason) && /not a function a card may call/.test(local.reason));
  const empty = compileSurface({ surface: "s", components: [] }, undefined);
  assert.ok(!empty.ok && /non-empty/.test(empty.reason));
});

test("the action line round-trips, with and without context", () => {
  const line = actionText({ name: "pick", surfaceId: "s1", context: { choice: "a", note: "x: y" } });
  assert.equal(line, '[Action "pick" on card s1: {"choice":"a","note":"x: y"}]');
  assert.deepEqual(parseActionText(line), { name: "pick", surfaceId: "s1", context: { choice: "a", note: "x: y" } });
  assert.deepEqual(parseActionText(actionText({ name: "ok", surfaceId: "plan" })), { name: "ok", surfaceId: "plan" });
  assert.equal(parseActionText("hello"), undefined);
});

test("the ledger survives a restart, latest line wins, closed stays closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-surfaces-"));
  const path = join(dir, "surfaces.jsonl");
  try {
    const first = new SurfaceLedger(path);
    const record: SurfaceRecord = { agentId: "a1", agentName: "Ada", conversation: "main", surfaceId: "s1", messages: [], at: "t1" };
    first.record(record);
    first.record({ ...record, title: "Plan", at: "t2" });
    first.record({ ...record, surfaceId: "s2", at: "t3" });
    first.close("a1", "main", "s2");
    appendFileSync(path, '{"kind":"surf');
    const second = new SurfaceLedger(path);
    assert.equal(second.get("a1", "main", "s1")?.title, "Plan");
    assert.equal(second.get("a1", "main", "s2"), undefined);
    assert.equal(second.list("a1").length, 1);
    assert.ok(readFileSync(path, "utf8").split("\n").length >= 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tool hands the card to the host and reports where it went; a refusal is an error with the reason", async () => {
  const shown: unknown[] = [];
  const context = {
    agent: { id: "a1", profile: { name: "Ada" } },
    conversation: "main",
    registry: {} as never,
    bus: {} as never,
    showUI: async (input: { surface: string; close?: boolean }) => {
      shown.push(input);
      return input.surface === "bad" ? { error: 'Component "Image" (root) is not in the catalog.' } : { where: "in the app" };
    },
  } as unknown as Parameters<typeof dispatchTool>[2];
  const ok = await dispatchTool("ShowUI", { surface: "plan", components: card, title: "Plans" }, context);
  assert.ok(!ok.isError, ok.text);
  assert.match(ok.text, /Shown in the app as card plan/);
  assert.match(ok.text, /Your turn does not end|continue, or stop/);
  assert.equal((shown[0] as { title?: string }).title, "Plans");
  const bad = await dispatchTool("ShowUI", { surface: "bad", components: card }, context);
  assert.ok(bad.isError && /Not shown: Component "Image"/.test(bad.text));
  const closed = await dispatchTool("ShowUI", { surface: "plan", close: true }, context);
  assert.ok(!closed.isError && /Closed card plan/.test(closed.text));
  const badId = await dispatchTool("ShowUI", { surface: "has space" }, context);
  assert.ok(badId.isError);
  const nobody = await dispatchTool("ShowUI", { surface: "plan", components: card }, { ...(context as object), showUI: undefined } as never);
  assert.ok(nobody.isError && /nobody to show/.test(nobody.text));
  assert.ok(PERSON_FACING_TOOLS.has("ShowUI") && FORK_WITHHELD_TOOLS.has("ShowUI"));
});

test("what the first live run sent is read as what it meant: `{item: [...]}` arrays unwrapped, `type` as `component` (2026-10-19)", () => {
  const sent = {
    surface: "pick-option",
    components: [
      { id: "root", type: "Column", children: { item: ["intro", "row"] } },
      { id: "intro", type: "Text", text: "点下面一个按钮。" },
      { id: "row", type: "Row", children: { item: { item: ["btnA", "btnB"] } } },
      { id: "btnA", type: "Button", action: { event: { name: "pick", context: { choice: "a" } } }, child: "al" },
      { id: "al", type: "Text", text: "方案 A" },
      { id: "btnB", type: "Button", action: { event: { name: "pick", context: { choice: "b" } } }, child: "bl" },
      { id: "bl", type: "Text", text: "方案 B" },
    ],
  };
  const compiled = compileSurface(sent, undefined);
  assert.ok(compiled.ok, compiled.ok ? "" : compiled.reason);
  const components = (compiled.full[1] as { updateComponents: { components: Record<string, unknown>[] } }).updateComponents.components;
  assert.deepEqual(components[0], { id: "root", component: "Column", children: ["intro", "row"] });
  assert.deepEqual(components[2]!.children, ["btnA", "btnB"]);
  assert.ok(components.every(component => !("type" in component)));
  // A single wrapped id is still a list of one.
  const one = compileSurface({ surface: "s", components: [{ id: "root", component: "Column", children: { item: "t" } }, { id: "t", component: "Text", text: "x" }] }, undefined);
  assert.ok(one.ok, one.ok ? "" : one.reason);
});

test("a Table is in the catalog with its rows and selection bound to the data model; a wrong shape is refused by name (INV-1280)", () => {
  const card = [
    { id: "root", component: "Column", children: ["t", "go"] },
    { id: "t", component: "Table", columns: [{ key: "name", label: "Name" }, { key: "size", label: "Size", align: "end" }], rows: { path: "/rows" }, selectable: true, value: { path: "/picked" }, caption: "bytes" },
    { id: "go", component: "Button", child: "gl", action: { event: { name: "pick", context: { rows: { path: "/picked" } } } } },
    { id: "gl", component: "Text", text: "Use these" },
  ];
  const ok = compileSurface({ surface: "files", components: card, data: { rows: [{ name: "a.txt", size: 12 }], picked: [] } }, undefined);
  assert.ok(ok.ok, ok.ok ? "" : ok.reason);
  const bad = compileSurface({ surface: "files", components: [{ id: "root", component: "Table", columns: "Name", rows: [] }] }, undefined);
  assert.ok(!bad.ok && /Table.*columns/.test(bad.reason), bad.ok ? "" : bad.reason);
  const invented = compileSurface({ surface: "files", components: [{ id: "root", component: "Table", columns: [{ key: "a", label: "A" }], rows: [], striped: true }] }, undefined);
  assert.ok(!invented.ok && /striped/.test(invented.reason), invented.ok ? "" : invented.reason);
});

test("Progress, Markdown, Code and Approve are in the catalog; an Approve without actions gets approve/reject events (INV-1280)", () => {
  const card = [
    { id: "root", component: "Column", children: ["p", "m", "c", "a"] },
    { id: "p", component: "Progress", title: "Deploy", steps: { path: "/steps" }, label: "building" },
    { id: "m", component: "Markdown", text: "# Hi\n\n- one\n- two" },
    { id: "c", component: "Code", text: "-a\n+b", variant: "diff", title: "x.ts" },
    { id: "a", component: "Approve", title: "Ship it?", detail: "to prod" },
  ];
  const ok = compileSurface({ surface: "d", components: card, data: { steps: [{ label: "build", status: "doing" }] } }, undefined);
  assert.ok(ok.ok, ok.ok ? "" : ok.reason);
  const approve = (ok.full[1] as { updateComponents: { components: Record<string, unknown>[] } }).updateComponents.components.find(c => c.id === "a")!;
  assert.deepEqual(approve.onApprove, { event: { name: "approve" } });
  assert.deepEqual(approve.onReject, { event: { name: "reject" } });
  const kept = compileSurface({ surface: "d", components: [{ id: "root", component: "Approve", onApprove: { event: { name: "ship", context: { env: "prod" } } } }] }, undefined);
  assert.ok(kept.ok, kept.ok ? "" : kept.reason);
  const comp = (kept.full[1] as { updateComponents: { components: Record<string, unknown>[] } }).updateComponents.components[0]!;
  assert.deepEqual(comp.onApprove, { event: { name: "ship", context: { env: "prod" } } }, "the agent's own event is kept");
  assert.deepEqual(comp.onReject, { event: { name: "reject" } });
});

test("a data-only or patch call moves an existing card without resending components; a card may call catalog functions but not openUrl (INV-1280)", () => {
  const first = compileSurface({ surface: "p", components: [{ id: "root", component: "Progress", title: "Deploy", steps: { path: "/steps" } }], data: { steps: [{ label: "build", status: "doing" }] } }, undefined);
  assert.ok(first.ok, first.ok ? "" : first.reason);
  const existing: SurfaceRecord = { agentId: "a", agentName: "Ada", conversation: "main", surfaceId: "p", messages: first.full, at: "t" };
  const moved = compileSurface({ surface: "p", patch: [{ path: "/steps/0/status", value: "done" }] }, existing);
  assert.ok(moved.ok, moved.ok ? "" : moved.reason);
  assert.deepEqual(moved.send, [{ version: "v0.9", updateDataModel: { surfaceId: "p", path: "/steps/0/status", value: "done" } }]);
  assert.equal(moved.full.length, first.full.length + 1, "the full list grows by the edit");
  const whole = compileSurface({ surface: "p", data: { steps: [] } }, existing);
  assert.ok(whole.ok && whole.send.length === 1 && "updateDataModel" in whole.send[0]!);
  const badPatch = compileSurface({ surface: "p", patch: [{ path: "steps", value: 1 }] }, existing);
  assert.ok(!badPatch.ok && /starting with/.test(badPatch.reason));
  const nothingYet = compileSurface({ surface: "q", data: { x: 1 } }, undefined);
  assert.ok(!nothingYet.ok && /Pass `components`/.test(nothingYet.reason), "no card to move yet");
  // Functions: a catalog function in a property is fine; openUrl is not a thing a card does.
  const fn = compileSurface({ surface: "f", components: [{ id: "root", component: "Text", text: { call: "formatNumber", args: { value: 1234.5 } } }] }, undefined);
  assert.ok(fn.ok, fn.ok ? "" : fn.reason);
  const open = compileSurface({ surface: "f", components: [{ id: "root", component: "Button", child: "l", action: { functionCall: { call: "openUrl", args: { url: "https://x" } } } }, { id: "l", component: "Text", text: "go" }] }, undefined);
  assert.ok(!open.ok && /openUrl/.test(open.reason) && /Available/.test(open.reason), open.ok ? "" : open.reason);
  // The wider basic catalog, without Image.
  const tabs = compileSurface({ surface: "t", components: [{ id: "root", component: "Tabs", tabs: [{ title: "A", child: "a" }] }, { id: "a", component: "Text", text: "x" }] }, undefined);
  assert.ok(tabs.ok, tabs.ok ? "" : tabs.reason);
  const image = compileSurface({ surface: "i", components: [{ id: "root", component: "Image", url: "https://x/y.png" }] }, undefined);
  assert.ok(!image.ok && /not in the catalog/.test(image.reason));
});
