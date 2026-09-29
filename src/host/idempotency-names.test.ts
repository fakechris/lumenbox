/**
 * INV-868: the idempotency declarations (src/protocol/idempotency.ts) are keyed by tool name, and a
 * key that names no tool declares nothing — the call falls to `unsafe`. The table once said
 * `Read`/`Write`/`Grep`/`Glob` while the tools were `read_file`/`write_file`, so a crash recovery
 * answered every interrupted read "outcome unknown" and never replayed a keyed write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_IDEMPOTENCY, idempotencyOf } from "../protocol/idempotency.ts";
import { buildTools } from "./tools.ts";

test("every idempotency declaration names a tool that exists (INV-868)", () => {
  // Every flag on, so a tool offered only in one mode is still a name; connector_request is
  // offered only when a connector is configured (tools.ts), which no flag here turns on.
  const registered = new Set([...buildTools(true, true, undefined, true).map(tool => tool.name), "connector_request"]);
  const unknown = Object.keys(TOOL_IDEMPOTENCY).filter(name => !registered.has(name));
  assert.deepEqual(unknown, [], "a declaration for a tool that does not exist declares nothing");
});

test("the tools a resume leans on are declared under their real names (INV-868)", () => {
  assert.deepEqual(idempotencyOf("read_file"), { kind: "read" });
  assert.deepEqual(idempotencyOf("write_file"), { kind: "idempotent", key: "path" });
  assert.deepEqual(idempotencyOf("edit_file"), { kind: "unsafe" }, "an edit applied twice is two edits");
  assert.deepEqual(idempotencyOf("bash"), { kind: "unsafe" });
});
