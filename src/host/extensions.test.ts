import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Extensions } from "./extensions.ts";
import { McpManager } from "./mcp.ts";

function dir(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agentbox-ext-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("an extension registers tools and listeners; the tools reach the MCP manager as ext__<name> and calls run in-process (docs/34)", async () => {
  const { root, cleanup } = dir();
  try {
    writeFileSync(
      join(root, "greet.mjs"),
      `export default function (api) {
        api.tool({ name: "greet", description: "Says hello.", inputSchema: { type: "object", properties: { who: { type: "string" } } }, run: input => "hello " + (input.who ?? "there") });
        api.on("text", event => { globalThis.__seen = (globalThis.__seen ?? 0) + 1; });
        api.log("ready");
      }\n`
    );
    const log: string[] = [];
    const extensions = new Extensions(root, line => log.push(line));
    const result = await extensions.load();
    assert.deepEqual(result, { loaded: ["greet.mjs"], tools: ["ext__greet"], problems: [] });
    assert.ok(log.some(line => line.includes("greet.mjs: ready")));

    const manager = new McpManager([]);
    assert.equal(manager.setVirtual(extensions.server()), true);
    assert.deepEqual(manager.tools().map(tool => tool.name), ["ext__greet"]);
    assert.equal(manager.owns("ext__greet"), true);
    assert.equal(await manager.call("ext__greet", { who: "Chris" }), "hello Chris");
    assert.deepEqual(manager.statuses().map(s => [s.name, s.running, s.toolCount]), [["ext", true, 1]]);

    extensions.emit({ type: "text", agentId: "a", agentName: "Ada", delta: "hi" });
    extensions.emit({ type: "round", agentId: "a", round: 1 });
    assert.equal((globalThis as { __seen?: number }).__seen, 1, "only the subscribed type");
  } finally {
    delete (globalThis as { __seen?: number }).__seen;
    cleanup();
  }
});

test("reload picks up an edit; a bad file, a loose file and a duplicate tool are problems, not failures", async () => {
  const { root, cleanup } = dir();
  try {
    writeFileSync(join(root, "a.mjs"), `export default api => { api.tool({ name: "one", description: "1", run: () => "1" }); }\n`);
    writeFileSync(join(root, "b.mjs"), `export default api => { api.tool({ name: "one", description: "dup", run: () => "dup" }); api.tool({ name: "two", description: "2", run: () => "2" }); }\n`);
    writeFileSync(join(root, "broken.mjs"), `export default 42;\n`);
    writeFileSync(join(root, "throws.mjs"), `export default () => { throw new Error("no thanks"); }\n`);
    writeFileSync(join(root, "loose.mjs"), `export default api => { api.tool({ name: "never", description: "x", run: () => "x" }); }\n`);
    chmodSync(join(root, "loose.mjs"), 0o666);
    mkdirSync(join(root, "not-a-file.mjs"));
    const extensions = new Extensions(root);
    const first = await extensions.load();
    assert.deepEqual(first.loaded, ["a.mjs", "b.mjs"]);
    assert.deepEqual(first.tools, ["ext__one", "ext__two"]);
    assert.ok(first.problems.some(line => line.startsWith("b.mjs: tool one is already registered")));
    assert.ok(first.problems.some(line => line.startsWith("broken.mjs: does not default-export")));
    assert.ok(first.problems.some(line => line.startsWith("throws.mjs: no thanks")));
    assert.ok(first.problems.some(line => line.startsWith("loose.mjs: refused — writable")));

    // An edit, then a reload: the new registration replaces the old, nothing lingers.
    writeFileSync(join(root, "a.mjs"), `export default api => { api.tool({ name: "uno", description: "1", run: () => "uno!" }); }\n`);
    const second = await extensions.load();
    assert.deepEqual(second.tools, ["ext__uno", "ext__one", "ext__two"], "a.mjs now registers uno; b.mjs's one is no longer a duplicate");
    assert.ok(!second.problems.some(line => line.includes("already registered")));
  } finally {
    cleanup();
  }
});

test("a manager reload keeps the in-process server, and a configured server of the same name wins", async () => {
  const { root, cleanup } = dir();
  try {
    writeFileSync(join(root, "x.mjs"), `export default api => { api.tool({ name: "x", description: "x", run: () => "x" }); }\n`);
    const extensions = new Extensions(root);
    await extensions.load();
    const manager = new McpManager([]);
    manager.setVirtual(extensions.server());
    manager.reload([]);
    assert.deepEqual(manager.tools().map(tool => tool.name), ["ext__x"], "config reload leaves the virtual server alone");

    const taken = new McpManager([{ name: "ext", command: process.execPath, args: ["-e", "setTimeout(()=>{},1000)"] }]);
    const log: string[] = [];
    const guarded = new McpManager([{ name: "ext", command: process.execPath, args: ["-e", "0"] }], line => log.push(line));
    assert.equal(guarded.setVirtual(extensions.server()), false);
    assert.match(log.join("\n"), /already named ext/);
    taken.stop();
    guarded.stop();
  } finally {
    cleanup();
  }
});
