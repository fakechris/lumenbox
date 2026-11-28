/**
 * The surface ratchet (INV-2201, docs/106 §7): taking something off the stable surface fails and
 * says what to do, adding to it fails until the baseline says so, and a removal the deprecation
 * list has let go of passes. The CLI and config readers are run on the real sources with one
 * thing taken out, so what is proved is that a real removal is seen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASELINE_FILE, apiItems, cliSurface, interfaceKeys, listedEnv, surfaceItems, verify, written } from "./surface-ratchet.mjs";

const cliSource = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
const configSource = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const tool = { name: "assign_task", readOnly: false, inputSchema: { type: "object", properties: { brief: { type: "string" }, agent: { type: "string" }, scope: { type: "string", enum: ["mine", "all"] } }, required: ["brief"] } };
const surface = (overrides = {}) => surfaceItems({ cli: cliSurface(cliSource), config: interfaceKeys(configSource, "AgentboxConfig"), env: listedEnv(cliSource), tools: [tool], ...overrides });
const baseline = surface();

test("the readers see the real surface: a stable command with its flags, a config key with its type, a listed variable, a tool's fields", () => {
  assert.equal(baseline["cli/box down/--rm"], "flag");
  assert.equal(baseline["cli/audit export/--box"], "flag", "a flag read from a map keyed without dashes");
  assert.equal(baseline["cli/control up/--allocator"], "flag", "the default subcommand");
  assert.equal(baseline["cli/template import/--name"], "flag");
  assert.equal(baseline["cli/template share/--name"], undefined, "a flag belongs to the subcommand that reads it");
  assert.equal(baseline["cli/box shot"], undefined, "a command outside the stable list is no promise");
  assert.equal(baseline["config/activityLimit"], "number");
  assert.equal(baseline["config/provider"], "string, optional");
  assert.equal(baseline["env/AGENTBOX_HOME"], "listed by agentbox help");
  assert.equal(baseline["mcp/tool/assign_task/brief"], "string, required");
  assert.equal(baseline["mcp/tool/assign_task/scope=all"], "enum value");
  assert.deepEqual(verify(baseline, surface()), { problems: [], due: [] }, "held as it is");
});

test("a CLI flag, a config key or an MCP tool field taken away fails, naming it and the two ways out", () => {
  const cases = [
    ["cli/box down/--rm", surface({ cli: cliSurface(cliSource.replaceAll('"--rm"', '"--gone"')) })],
    ["config/boxImage", surface({ config: interfaceKeys(configSource.replace(/^ {2}boxImage\?: string;$/m, ""), "AgentboxConfig") })],
    ["mcp/tool/assign_task/agent", surface({ tools: [{ ...tool, inputSchema: { ...tool.inputSchema, properties: { brief: tool.inputSchema.properties.brief, scope: tool.inputSchema.properties.scope } } }] })],
  ];
  for (const [item, measured] of cases) {
    assert.equal(measured[item], undefined, `${item} was taken out of the copy`);
    const gone = verify(baseline, measured).problems.filter(problem => problem.startsWith(`${item} `));
    assert.equal(gone.length, 1, `${item}: ${verify(baseline, measured).problems.join(" | ")}`);
    assert.match(gone[0], /is gone from the stable surface\. .*put it back, or list it in src\/deprecations\.ts/);
    assert.equal(written(baseline, measured)[item], baseline[item], "--write-baseline does not let go of it");
  }
  // A whole command: its flags go with it, each reported.
  const noLogs = surface({ cli: cliSurface(cliSource.replace('case "logs":', 'case "journal":')) });
  assert.deepEqual(verify(baseline, noLogs).problems.map(problem => problem.split(" (")[0]), ["cli/box logs", "cli/box logs/--tail"], "a renamed command is a removed one");
});

test("a changed type fails like a removal: an optional field made required, a string made a number", () => {
  const required = surface({ tools: [{ ...tool, inputSchema: { ...tool.inputSchema, required: ["brief", "agent"] } }] });
  assert.match(verify(baseline, required).problems.join("\n"), /^mcp\/tool\/assign_task\/agent changed from "string" to "string, required"\. Somebody may depend on it/);
  const retyped = surface({ config: { ...interfaceKeys(configSource, "AgentboxConfig"), activityLimit: "string" } });
  assert.match(verify(baseline, retyped).problems.join("\n"), /^config\/activityLimit changed from "number" to "string"/);
});

test("an addition fails until the baseline has it, and the message says to update the baseline and the release notes", () => {
  const more = surface({ tools: [{ ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, priority: { type: "number" } } } }] });
  const { problems } = verify(baseline, more);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^1 item\(s\) are new on the stable surface: mcp\/tool\/assign_task\/priority\./);
  assert.ok(problems[0].includes("Update the baseline") && problems[0].includes("--write-baseline") && problems[0].includes("add a line to the release notes"), problems[0]);
  const next = written(baseline, more);
  assert.equal(next["mcp/tool/assign_task/priority"], "number", "--write-baseline adds it");
  assert.deepEqual(verify(next, more), { problems: [], due: [] });
  assert.ok(BASELINE_FILE.endsWith(".json"));
});

test("a removal passes only when the deprecation list has the item and its line has come", () => {
  const measured = surface({ cli: cliSurface(cliSource.replace('case "logs":', 'case "journal":'), ["box up", "box logs"]) });
  const before = surface({ cli: cliSurface(cliSource, ["box up", "box logs"]) });
  const deprecations = [{ item: "cli/box logs", since: "0.5", replacement: "docker logs agentbox-box", removableFrom: "0.6" }];

  const early = verify(before, measured, deprecations, "0.5.3").problems;
  assert.equal(early.length, 2, "the command and its flag, both still owed");
  assert.match(early[0], /cli\/box logs is deprecated since 0\.5 but may only go from 0\.6, and this is 0\.5: keep it working until then/);

  assert.deepEqual(verify(before, measured, deprecations, "0.6.0"), { problems: [], due: ["cli/box logs", "cli/box logs/--tail"] }, "listing a command covers its flags");
  assert.deepEqual(verify(before, measured, deprecations, "0.10.0").problems, [], "0.10 is after 0.6");
  const next = written(before, measured, deprecations, "0.6.0");
  assert.equal(next["cli/box logs"], undefined, "and --write-baseline then drops the entries");
  assert.equal(next["cli/box up"], "command");
  // The neighbour that is not listed is still held.
  assert.equal(verify(before, surface({ cli: {} }), deprecations, "0.6.0").problems.some(problem => problem.startsWith("cli/box up ")), true);
});

test("the client API's document is on the surface: a field, a known value or an operation taken out fails; an addition needs the revision raised; the revision only rises", async () => {
  const { openApiDocument } = await import("../src/web/client-api/openapi.ts");
  const document = openApiDocument();
  const held = surfaceItems({ openapi: document });
  assert.equal(held["api/op/GET /api/v1/me"], "operation getMe, scope any");
  assert.equal(held["api/schema/Me/role"], "string, required");
  assert.equal(held["api/schema/Me/role=admin"], "known value");
  assert.equal(held["api/op/GET /api/v1/me/error/access-removed"], "401");
  assert.deepEqual(verify(held, surfaceItems({ openapi: openApiDocument() })), { problems: [], due: [] }, "the same schema, the same items");

  const copy = () => JSON.parse(JSON.stringify(document));
  const noRole = copy(); delete noRole.components.schemas.Me.properties.role;
  const noAdmin = copy(); noAdmin.components.schemas.Me.properties.role["x-extensible-enum"] = ["viewer", "driver"];
  const noMe = copy(); delete noMe.paths["/api/v1/me"];
  for (const [item, changed] of [["api/schema/Me/role", noRole], ["api/schema/Me/role=admin", noAdmin], ["api/op/GET /api/v1/me", noMe]]) {
    assert.ok(verify(held, apiItems(changed)).problems.some(problem => problem.startsWith(`${item} `) && problem.includes("is gone from the stable surface")), item);
  }
  const optional = copy(); optional.components.schemas.Me.required = ["id", "name", "credential"];
  assert.match(verify(held, apiItems(optional)).problems.join("\n"), /api\/schema\/Me\/role changed from "string, required" to "string"/, "always present, then not: a change a client breaks on");

  const added = copy(); added.components.schemas.Me.properties.team = { type: "string" };
  const now = document.info.version, raised = `1.${Number(now.split(".")[1]) + 1}`;
  assert.ok(verify(held, apiItems(added)).problems.join("\n").includes(`gained items and its revision is still ${now}: raise API_REVISION`));
  added.info.version = raised;
  const next = written(held, apiItems(added));
  assert.equal(next["api/revision"], raised, "--write-baseline records the higher revision");
  assert.deepEqual(verify(next, apiItems(added)), { problems: [], due: [] });
  assert.ok(verify(next, apiItems(document)).problems.join("\n").includes(`api/revision went down from ${raised} to ${now}`));

  const preview = copy(); preview.paths["/api/v1/me"].get["x-tier"] = "preview";
  assert.equal(apiItems(preview)["api/op/GET /api/v1/me"], undefined, "a preview operation is no promise");
});
