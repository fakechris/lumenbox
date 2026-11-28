#!/usr/bin/env node
/**
 * The surface ratchet (INV-2201, docs/106 §7): what somebody outside may depend on is written
 * down once, and from then on changes only by addition — or through the deprecation list.
 *
 * The prompt ratchet (prompt-ratchet.mjs) holds what an agent is sent. This holds what a person
 * running an installation, a script, an MCP client or a webhook sender relies on: the Stable
 * list of docs/106 §3. `surface-baseline.json` has one line per item, read off the code:
 *
 *   - **cli/…** (S4): the commands for running an installation and each one's flags, from
 *     `src/cli.ts`'s dispatch — the `case` that routes the command and the flag literals in the
 *     function it routes to. Not from the usage text: a flag the text forgot is still a contract.
 *   - **config/…** (S3): `AgentboxConfig`'s top-level keys with their declared types.
 *   - **env/…** (S3): the environment variables `agentbox help` lists.
 *   - **mcp/…** (S5): the side door's tools and every field of their input schemas, the
 *     capability map, the task states and the reasons a task is incomplete.
 *   - **webhook/…** (S6): the header names a routine's sender may authenticate with.
 *   - **skill/…, rule/…, template/…** (S7): skill frontmatter keys, rule-file fields and their
 *     aliases, the template format.
 *   - **api/…** (S10): the client API, read off its OpenAPI document (`docs/api/v1.openapi.json`,
 *     built from `src/web/client-api/schema.ts`): every stable operation with its scope, parameters,
 *     answer and error codes; every resource field with its type and whether it is always present;
 *     every known value of an open enumeration; every scope. Preview operations are no promise and
 *     are not held. `api/revision` may only rise, and must rise with any `api/…` addition
 *     (docs/106 §4.1). The document itself must be what the schema builds: when it is not, the check
 *     fails and `--write-baseline` writes it.
 *
 * Three outcomes for an item:
 *
 *   - **added** (measured, not in the baseline): fails until the baseline has it — run
 *     `node scripts/surface-ratchet.mjs --write-baseline` and add a line to the release notes.
 *     An addition is a promise; making one should be a visible diff, not an accident.
 *   - **removed or changed** (in the baseline, gone or different): fails, unless
 *     `src/deprecations.ts` lists the item and this release line is at or past its
 *     `removableFrom`. Then it passes and `--write-baseline` drops or rewrites the entry.
 *   - **unchanged**: nothing.
 *
 * `--write-baseline` therefore adds what is new and drops what the deprecation list allows; it
 * never drops or rewrites anything else, so it cannot be the way a contract is broken.
 *
 * What this does not hold, said so nobody reads the tick as more: exit statuses, the files
 * `audit export` writes, HTTP status codes, a flag read by a helper in another module, and the
 * behaviour behind an operation (the contract tests in `src/web/client-api/` hold that).
 *
 *   node scripts/surface-ratchet.mjs                    check (run by `npm run arch`)
 *   node scripts/surface-ratchet.mjs --write-baseline   add what is new; drop what is deprecated and due
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// Plain TypeScript with nothing to transform, so Node reads it as it is: when an item may go is decided in one place.
import { deprecationOf, releaseLine, removable } from "../src/deprecations.ts";
import { hermeticEnv } from "./test-env.mjs";

export const BASELINE_FILE = "surface-baseline.json";
export const OPENAPI_FILE = "docs/api/v1.openapi.json";
export const DEPRECATIONS_FILE = "src/deprecations.ts";
const root = fileURLToPath(new URL("..", import.meta.url));

/** The S4 list of docs/106 §3, as `agentbox <command> [sub]`. The list is the promise; what each takes is read from the code. */
export const STABLE_COMMANDS = [
  "box up", "box down", "box status", "box upgrade", "box rollback", "box logs", "box attach", "box detach", "box list",
  "backup", "web", "chat", "agents", "agent new",
  "template import", "template share", "template download",
  "mcp", "usage", "audit export", "control up", "control status",
];

// --- reading the code ------------------------------------------------------

/** Source without its comments, so a flag named in prose is not read as one the code takes. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
}

/** The body of a top-level function, from its declaration to the closing brace in column 0. */
function functionBody(source, name) {
  const start = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m").exec(source);
  if (start === null) return undefined;
  const end = source.indexOf("\n}\n", start.index);
  return source.slice(start.index, end === -1 ? undefined : end);
}

/** A `case "name":` at exactly `indent` spaces, up to the next case or default at that depth. */
function caseBlock(source, name, indent) {
  const pad = " ".repeat(indent);
  const start = new RegExp(`^${pad}case "${name}":`, "m").exec(source);
  if (start === null) return undefined;
  const rest = source.slice(start.index + start[0].length);
  const end = new RegExp(`^${pad}(?:case |default:)`, "m").exec(rest);
  return start[0] + (end === null ? rest : rest.slice(0, end.index));
}

/** Where a routed piece of code goes: the function it returns at once, or itself when it does the work inline. */
function routed(source, block) {
  const handler = /^\s*(?:case "[^"]+":|if \(sub === "[^"]+"\))\s*return (cmd\w+)\(/.exec(block);
  return handler === null ? block : (functionBody(source, handler[1]) ?? block);
}

/** A subcommand inside a region: a nested `case "sub":`, or an `if (sub === "sub")` up to the next one. */
function subcommand(source, region, sub) {
  const nested = /^(\s+)case "/m.exec(region.slice(region.indexOf("\n")));
  const asCase = nested === null ? undefined : caseBlock(region, sub, nested[1].length);
  if (asCase !== undefined) return routed(source, asCase);
  const start = region.indexOf(`if (sub === "${sub}")`);
  if (start !== -1) {
    const next = region.indexOf('if (sub === "', start + 1);
    return routed(source, region.slice(start, next === -1 ? undefined : next));
  }
  // An inline block that takes one subcommand and refuses the rest: `if (rest[0] !== "export")`.
  if (region.includes(`rest[0] !== "${sub}"`)) return region;
  // The default subcommand: `const [sub = "up", ...]`, with what is left after the others returned.
  if (new RegExp(`\\[sub = "${sub}"`).test(region)) return region.slice(region.lastIndexOf('if (sub !== "'));
  return undefined;
}

/** The flags a piece of code takes: `"--name"` literals, `"--name="` prefixes, and `flags.get("name")` on a map keyed without dashes. */
function flagsIn(region) {
  const flags = new Set();
  for (const match of region.matchAll(/["'`](--[a-z][a-z0-9-]*)=?["'`]/g)) flags.add(match[1]);
  for (const match of region.matchAll(/\bflags\.get\("([a-z][a-z0-9-]*)"\)/g)) flags.add(`--${match[1]}`);
  return [...flags].sort();
}

/** `{ "box up": ["--recreate", …], … }` for the stable commands the dispatch still routes; one it does not route is absent. */
export function cliSurface(cliSource, commands = STABLE_COMMANDS) {
  const source = code(cliSource);
  const main = functionBody(source, "main") ?? "";
  const surface = {};
  for (const command of commands) {
    const [top, sub] = command.split(" ");
    const block = caseBlock(main, top, 4);
    if (block === undefined) continue;
    const region = routed(source, block);
    const found = sub === undefined ? region : subcommand(source, region, sub);
    if (found !== undefined) surface[command] = flagsIn(found);
  }
  return surface;
}

/** The environment variables the usage text names, as it writes them (`AGENTBOX_WIDTH/HEIGHT` is one entry). */
export function listedEnv(cliSource) {
  const usage = /const USAGE = `([\s\S]*?)`;\n/.exec(cliSource)?.[1] ?? "";
  return [...new Set(usage.match(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+(?:\/_?[A-Z0-9_]+)*/g) ?? [])].sort();
}

/** `{ key: "declared type" }` for the top-level members of an exported interface; `?` marks an optional one. */
export function interfaceKeys(source, name) {
  const start = new RegExp(`^export interface ${name} \\{$`, "m").exec(source);
  if (start === null) return {};
  const end = source.indexOf("\n}\n", start.index);
  const body = code(source.slice(start.index + start[0].length, end));
  const keys = {};
  let depth = 0;
  let member = "";
  const close = () => {
    const parsed = /^\s*(\w+)(\??):\s*([\s\S]+)$/.exec(member);
    if (parsed !== null) keys[parsed[1]] = `${parsed[3].replace(/\s+/g, " ").trim()}${parsed[2] === "?" ? ", optional" : ""}`;
    member = "";
  };
  for (const char of body) {
    if ("{([<".includes(char)) depth += 1;
    if ("})]>".includes(char)) depth -= 1;
    if (char === ";" && depth === 0) close();
    else member += char;
  }
  close();
  return keys;
}

/** The members of an exported string-literal union: `export type T = "a" | "b";`. */
export function unionMembers(source, name) {
  const declared = new RegExp(`^export type ${name} = ([^;]+);`, "m").exec(source)?.[1] ?? "";
  return [...declared.matchAll(/"([^"]+)"/g)].map(match => match[1]);
}

/** A JSON schema's type in a few words: what a caller has to send. */
function schemaType(schema) {
  if (schema === null || typeof schema !== "object") return "any";
  const type = Array.isArray(schema.type) ? schema.type.join("|") : (schema.type ?? "any");
  return type === "array" ? `array of ${schemaType(schema.items)}` : type;
}

/** One tool's input schema as items: each field with its type and whether it is required, each enum value, nested objects by path. */
function schemaItems(prefix, schema, into) {
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  for (const [field, definition] of Object.entries(schema?.properties ?? {})) {
    const path = `${prefix}/${field}`;
    into[path] = `${schemaType(definition)}${required.has(field) ? ", required" : ""}`;
    const values = definition?.enum ?? definition?.items?.enum;
    if (Array.isArray(values)) for (const value of values) into[`${path}=${value}`] = "enum value";
    if (definition?.type === "object") schemaItems(path, definition, into);
    if (definition?.items?.type === "object") schemaItems(`${path}[]`, definition.items, into);
  }
}

/** A schema's type in a few words, for the client API: `$ref`s by name, an open enumeration as a string. */
function apiType(schema) {
  if (schema?.$ref !== undefined) return schema.$ref.split("/").pop();
  if (schema?.type === "array") return `array of ${apiType(schema.items)}`;
  return `${schema?.type ?? "any"}${schema?.format !== undefined ? ` (${schema.format})` : ""}`;
}

/** Known values of an open enumeration at `path`, as items. */
function knownValues(path, schema, into) {
  for (const value of schema?.["x-extensible-enum"] ?? schema?.items?.["x-extensible-enum"] ?? []) into[`${path}=${value}`] = "known value";
}

/** The client API's items from its OpenAPI document: what a phone app or a company's back end relies on. */
export function apiItems(document) {
  const items = {};
  if (document === undefined) return items;
  items["api/revision"] = document.info.version;
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (operation["x-tier"] !== "stable") continue;
      const at = `api/op/${method.toUpperCase()} ${path}`;
      items[at] = `operation ${operation.operationId}, scope ${operation["x-scope"]}`;
      for (const param of operation.parameters ?? []) {
        items[`${at}/${param.in}/${param.name}`] = `${apiType(param.schema)}${param.required ? ", required" : ""}`;
        knownValues(`${at}/${param.in}/${param.name}`, param.schema, items);
      }
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        const schema = response.content?.["application/json"]?.schema;
        items[`${at}/response/${status}`] = schema === undefined ? "no body" : apiType(schema);
        for (const code of response["x-error-codes"] ?? []) items[`${at}/error/${code}`] = status;
      }
    }
  }
  for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
    items[`api/schema/${name}`] = apiType(schema);
    const required = new Set(schema.required ?? []);
    for (const [field, definition] of Object.entries(schema.properties ?? {})) {
      items[`api/schema/${name}/${field}`] = `${apiType(definition)}${required.has(field) ? ", required" : ""}`;
      knownValues(`api/schema/${name}/${field}`, definition, items);
    }
  }
  for (const [name, scheme] of Object.entries(document.components?.securitySchemes ?? {})) items[`api/security/${name}`] = `${scheme.type} ${scheme.scheme ?? ""}`.trim();
  return items;
}

/** "1.12" → 12. */
const revisionOf = version => Number.parseInt(String(version ?? "").split(".")[1] ?? "", 10);

/**
 * The whole surface as `{ item: what it is }`, from the pieces read off the code. Pure, so a test
 * can hand it a copy with a flag, a key or a field taken out.
 */
export function surfaceItems({ cli = {}, config = {}, env = [], tools = [], capabilities = {}, taskStates = [], incompleteReasons = [], webhookHeaders = {}, skillKeys = [], ruleFields = [], templateFormat, openapi }) {
  const items = { ...apiItems(openapi) };
  for (const [command, flags] of Object.entries(cli)) {
    items[`cli/${command}`] = "command";
    for (const flag of flags) items[`cli/${command}/${flag}`] = "flag";
  }
  for (const [key, type] of Object.entries(config)) items[`config/${key}`] = type;
  for (const name of env) items[`env/${name}`] = "listed by agentbox help";
  for (const tool of tools) {
    items[`mcp/tool/${tool.name}`] = tool.readOnly === true ? "tool, read-only" : "tool";
    schemaItems(`mcp/tool/${tool.name}`, tool.inputSchema, items);
  }
  for (const [capability, value] of Object.entries(capabilities)) items[`mcp/capability/${capability}`] = String(value);
  for (const state of taskStates) items[`mcp/state/${state}`] = "task state";
  for (const reason of incompleteReasons) items[`mcp/incomplete/${reason}`] = "reason a task is incomplete";
  for (const [purpose, names] of Object.entries(webhookHeaders)) for (const header of names) items[`webhook/${purpose}/${header}`] = "header";
  for (const key of skillKeys) items[`skill/frontmatter/${key}`] = "key";
  for (const field of ruleFields) {
    items[`rule/${field.key}`] = `${field.list ? "list" : "value"}${field.required ? ", required" : ""}`;
    for (const alias of field.aliases ?? []) items[`rule/${alias}`] = `alias of ${field.key}`;
  }
  if (templateFormat !== undefined) items[`template/format/${templateFormat}`] = "imports";
  return Object.fromEntries(Object.entries(items).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// --- the rule ---------------------------------------------------------------

/**
 * `{ problems, due }`: the sentences that fail the check, and the baseline entries a deprecation
 * that has come due lets go of. `deprecations` is `src/deprecations.ts`'s list; `version` decides
 * which release line this is.
 */
export function verify(baseline, measured, deprecations = [], version = "0.0.0") {
  const problems = [];
  const due = [];
  // The client API's revision is the one item that changes in place: up, and with every addition (docs/106 §4.1).
  const [was, now] = [baseline["api/revision"], measured["api/revision"]];
  if (was !== undefined && now !== undefined && revisionOf(now) < revisionOf(was)) problems.push(`api/revision went down from ${was} to ${now}: it only rises (API_REVISION in src/web/client-api/schema.ts)`);
  const apiAdded = Object.keys(measured).some(item => item.startsWith("api/") && item !== "api/revision" && baseline[item] === undefined);
  if (was !== undefined && apiAdded && revisionOf(now) <= revisionOf(was)) problems.push(`the client API gained items and its revision is still ${was}: raise API_REVISION in src/web/client-api/schema.ts, so a client can tell this server from one without them`);
  baseline = Object.fromEntries(Object.entries(baseline).filter(([item]) => item !== "api/revision"));
  measured = Object.fromEntries(Object.entries(measured).filter(([item]) => item !== "api/revision"));
  const added = Object.keys(measured).filter(item => baseline[item] === undefined);
  if (added.length > 0) {
    problems.push(`${added.length} item(s) are new on the stable surface: ${added.join(", ")}. Each is a promise from now on (docs/106 §3). Update the baseline — \`node scripts/surface-ratchet.mjs --write-baseline\` — and add a line to the release notes saying what was added`);
  }
  for (const [item, was] of Object.entries(baseline)) {
    const now = measured[item];
    if (now === was) continue;
    const what = now === undefined ? `${item} (${was}) is gone from the stable surface` : `${item} changed from "${was}" to "${now}"`;
    const entry = deprecationOf(item, deprecations);
    if (entry === undefined) {
      problems.push(`${what}. Somebody may depend on it: put it back, or list it in ${DEPRECATIONS_FILE} (what, since which line, what replaces it, removable from) and keep it working until that line`);
    } else if (!removable(entry, version)) {
      problems.push(`${what}. ${entry.item} is deprecated since ${entry.since} but may only go from ${entry.removableFrom}, and this is ${releaseLine(version)}: keep it working until then`);
    } else {
      due.push(item);
    }
  }
  return { problems, due };
}

/** The baseline after `--write-baseline`: what is new added, what a due deprecation covers dropped or rewritten, everything else as it was. */
export function written(baseline, measured, deprecations = [], version = "0.0.0") {
  const { due } = verify(baseline, measured, deprecations, version);
  const next = { ...baseline };
  if (measured["api/revision"] !== undefined && (next["api/revision"] === undefined || revisionOf(measured["api/revision"]) > revisionOf(next["api/revision"]))) next["api/revision"] = measured["api/revision"];
  for (const item of due) {
    if (measured[item] === undefined) delete next[item];
    else next[item] = measured[item];
  }
  for (const [item, what] of Object.entries(measured)) if (next[item] === undefined) next[item] = what;
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// --- measuring --------------------------------------------------------------

/** Reads the surface in a child process: the product is TypeScript, and must not see this shell's installation. */
function measure() {
  const run = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), "--measure"], {
    cwd: root, encoding: "utf8", env: hermeticEnv(), maxBuffer: 1 << 26,
  });
  const last = (run.stdout ?? "").trim().split("\n").pop() ?? "";
  if (run.status !== 0 || !last.startsWith("{")) throw new Error(`the surface could not be read (exit ${run.status}): ${(run.stderr ?? "").trim().split("\n").slice(-5).join(" | ")}`);
  return JSON.parse(last);
}

/** The real definitions, imported; the two files that cannot be imported (the CLI runs on import, an interface has no runtime) read as text. */
async function readSurface() {
  const load = path => import(pathToFileURL(join(root, path)).href);
  const text = path => readFileSync(join(root, path), "utf8");
  const [{ mcpServerTools }, { SIDE_DOOR_CAPABILITIES }, { WEBHOOK_AUTH_HEADERS }, { SKILL_FRONTMATTER_KEYS }, { RULE_FIELDS }, { TEMPLATE_FORMAT }, { DEPRECATIONS }, { openApiDocument, openApiText }] = await Promise.all([
    load("src/web/mcp-tools.ts"), load("src/web/mcp-contract.ts"), load("src/host/webhooks.ts"), load("src/host/skills.ts"), load("src/host/rules-grammar.ts"), load("src/host/template.ts"), load(DEPRECATIONS_FILE),
    load("src/web/client-api/openapi.ts"),
  ]);
  // Every optional dependency given, so every tool the door can carry is on it. Nothing is called: only the definitions are read.
  const never = () => { throw new Error("the surface ratchet reads tool definitions; it runs none"); };
  const tools = mcpServerTools({
    registry: {}, orchestrator: { tasks: {} }, principals: { resolve: id => ({ name: id }) }, workDir: "/work", log: () => {}, listen: () => () => {},
    mayDrive: never, changeFeed: {}, mayReadTask: never,
  });
  const cli = text("src/cli.ts");
  const contract = text("src/web/mcp-contract.ts");
  const items = surfaceItems({
    cli: cliSurface(cli),
    config: interfaceKeys(text("src/config.ts"), "AgentboxConfig"),
    env: listedEnv(cli),
    tools,
    capabilities: SIDE_DOOR_CAPABILITIES,
    taskStates: unionMembers(contract, "TaskState"),
    incompleteReasons: unionMembers(contract, "IncompleteReason"),
    webhookHeaders: WEBHOOK_AUTH_HEADERS,
    skillKeys: [...SKILL_FRONTMATTER_KEYS],
    ruleFields: RULE_FIELDS,
    templateFormat: TEMPLATE_FORMAT,
    openapi: openApiDocument(),
  });
  return { items, deprecations: DEPRECATIONS, version: JSON.parse(text("package.json")).version, openapi: openApiText() };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const path = join(root, BASELINE_FILE);
  if (args[0] === "--measure") {
    console.log(JSON.stringify(await readSurface()));
  } else {
    const { items, deprecations, version, openapi } = measure();
    const documentPath = join(root, OPENAPI_FILE);
    let document;
    try { document = readFileSync(documentPath, "utf8"); } catch { document = undefined; }
    let baseline;
    try { baseline = JSON.parse(readFileSync(path, "utf8")); } catch { baseline = {}; }
    if (args.includes("--write-baseline")) {
      const next = written(baseline, items, deprecations, version);
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
      if (document !== openapi) { mkdirSync(dirname(documentPath), { recursive: true }); writeFileSync(documentPath, openapi); console.log(`[surface] ${OPENAPI_FILE} written from src/web/client-api/schema.ts`); }
      const left = verify(next, items, deprecations, version).problems;
      console.log(`[surface] ${BASELINE_FILE}: ${Object.keys(next).length} item(s); additions written, removals only where ${DEPRECATIONS_FILE} allows. An addition needs a line in the release notes`);
      if (left.length > 0) {
        console.error(`[surface] --write-baseline does not remove or change a promise; ${left.length} problem(s) are left to a person:\n  ${left.join("\n  ")}`);
        process.exitCode = 1;
      }
    } else {
      const { problems, due } = verify(baseline, items, deprecations, version);
      if (document !== openapi) problems.push(`${OPENAPI_FILE} is not what src/web/client-api/schema.ts builds: run \`node scripts/surface-ratchet.mjs --write-baseline\` and commit the document with the change`);
      if (problems.length > 0) {
        console.error(problems.join("\n"));
        process.exitCode = 1;
      } else {
        console.log(`[surface] ok: ${Object.keys(items).length} stable item(s) held (docs/106 §3), ${deprecations.length} deprecated${due.length > 0 ? `; ${due.length} entr${due.length === 1 ? "y is" : "ies are"} past removal (${due.join(", ")}) — run \`node scripts/surface-ratchet.mjs --write-baseline\` to drop` : ""}`);
      }
    }
  }
}
