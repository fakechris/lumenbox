#!/usr/bin/env node
/**
 * The three registries hold (INV-1660): a chat command, a Settings pane and a rule-file key each
 * have one home, and this finds a second one.
 *
 *   - **commands** (src/channels/commands.ts): a slash command written in the channel layer or the
 *     host's command modules must be one the table lists, and no file there keeps a whole-message
 *     word list of its own (`[...].includes(t)`).
 *   - **settings** (src/web/settings-registry.ts): every `data-settab` key in src/web is a listed
 *     pane, every pane is used, and a tab anchor takes its title from the registry.
 *   - **rules** (src/host/rules-grammar.ts): rules.ts reads frontmatter only through the grammar's
 *     fields, never `meta.<key>` by hand.
 *
 * Run by `npm run arch` (arch-ratchet.mjs spawns it) and by architecture-guard.test.ts. Importing
 * the registries needs TypeScript, so the CLI re-runs itself under --experimental-transform-types.
 *
 *   node scripts/registry-guard.mjs     print the problems, exit 1 if any
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Production sources under src, as `{ path, text }` with paths like `channels/manager.ts`. */
export function sources(dir = join(root, "src")) {
  const out = [];
  const walk = at => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) {
        if (name === "catalog-data" || name === "node_modules" || name === "fixtures") continue;
        walk(full);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".sweep.ts") && !name.endsWith(".d.ts")) {
        out.push({ path: relative(dir, full).split(sep).join("/"), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return out;
}

/** Code without its comments, so prose about `/goal` is not read as a command. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
}

/** Where chat commands are dispatched: the channel layer and the host's command modules. */
const COMMAND_FILES = path =>
  (path.startsWith("channels/") && path !== "channels/commands.ts") ||
  ["host/goal-mode.ts", "host/context-recovery.ts", "host/task-recovery.ts", "host/retry-recovery.ts"].includes(path);

/** A string literal, roughly: enough to tell `"/stop"` from a regex literal like `/content|format/`. */
const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
/** A slash command inside a string: `"/stop"`, `"请单独发送 /new"`. Paths and URLs are not. */
const SLASH_IN_STRING = /(?:^|[\s（：，。、「])\/([a-z]+)(?![\w/.-])/g;
/** A slash command opening a regex alternative: `^\/goal`, `(?:\/join|入会)`. */
const SLASH_IN_REGEX = /(?:\^|\(\?:|\|)\\\/([a-z]+)\b/g;
/** An HTTP route a door serves or calls (tailmsg's `/health`, `path: "/msg"`) is not a chat command. */
const ROUTE = /(?:(?:url|pathname)\s*[!=]==|\bpath:)\s*$/;

function slashWords(text) {
  const out = [];
  const body = code(text);
  for (const literal of body.matchAll(STRING)) {
    if (ROUTE.test(body.slice(Math.max(0, literal.index - 40), literal.index))) continue;
    for (const match of literal[0].slice(1, -1).matchAll(SLASH_IN_STRING)) out.push(`/${match[1]}`);
  }
  for (const match of body.matchAll(SLASH_IN_REGEX)) out.push(`/${match[1]}`);
  return out;
}

export function commandProblems(files, registered) {
  const problems = [];
  for (const file of files.filter(f => COMMAND_FILES(f.path))) {
    const text = code(file.text);
    for (const word of slashWords(file.text)) {
      if (!registered.has(word)) problems.push(`${file.path}: ${word} is a chat command the table in src/channels/commands.ts does not list — add it there and dispatch through its parser`);
    }
    if (/\]\.includes\(t\)/.test(text)) problems.push(`${file.path}: a whole-message word list of its own — the words belong in src/channels/commands.ts`);
  }
  return [...new Set(problems)];
}

const SETTAB = [/data-settab=\\?"([\w-]+)\\?"/g, /"data-settab":\s*"([\w-]+)"/g, /getAttribute\("data-settab"\)\s*[!=]==\s*"([\w-]+)"/g];

export function settingsProblems(files, panes) {
  const problems = [];
  const keys = new Set(panes.map(pane => pane.key));
  const used = new Set();
  for (const file of files.filter(f => f.path.startsWith("web/") && f.path !== "web/settings-registry.ts")) {
    for (const pattern of SETTAB) {
      for (const match of file.text.matchAll(pattern)) {
        used.add(match[1]);
        if (!keys.has(match[1])) problems.push(`${file.path}: data-settab "${match[1]}" is not a pane in src/web/settings-registry.ts`);
      }
    }
    for (const line of file.text.split("\n")) {
      const anchor = /<a\b[^>]*data-settab=/.test(line) || /el\("a",\s*\{[^}]*"data-settab"/.test(line);
      if (anchor && !line.includes("settingsPane(")) problems.push(`${file.path}: a Settings tab written by hand — render it from src/web/settings-registry.ts (renderSettingsTabs, or settingsPane(key).title)`);
    }
  }
  for (const pane of panes) if (!used.has(pane.key)) problems.push(`settings pane ${pane.key} is listed but nothing in src/web carries data-settab="${pane.key}"`);
  return [...new Set(problems)];
}

export function rulesProblems(files) {
  const rules = files.find(f => f.path === "host/rules.ts");
  if (rules === undefined) return ["host/rules.ts is gone: the rules guard has nothing to hold"];
  const problems = [];
  for (const match of code(rules.text).matchAll(/\bmeta(?:\.([a-z]\w*)|\[\s*["'`]([^"'`]+)["'`]\s*\])/g)) {
    problems.push(`host/rules.ts reads the frontmatter key "${match[1] ?? match[2]}" by hand — read it through RULE_FIELDS in src/host/rules-grammar.ts`);
  }
  return problems;
}

/** Every problem, against the real tree and registries. */
export async function registryProblems(files = sources()) {
  const src = path => pathToFileURL(join(root, "src", path)).href;
  const { registeredSlashWords } = await import(src("channels/commands.ts"));
  const { SETTINGS_PANES } = await import(src("web/settings-registry.ts"));
  return [...commandProblems(files, registeredSlashWords()), ...settingsProblems(files, SETTINGS_PANES), ...rulesProblems(files)];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.AGENTBOX_REGISTRY_GUARD_CHILD === "1") {
    const problems = await registryProblems();
    for (const problem of problems) console.log(problem);
    process.exitCode = problems.length === 0 ? 0 : 1;
  } else {
    const child = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)], {
      stdio: "inherit",
      env: { PATH: process.env.PATH ?? "", AGENTBOX_REGISTRY_GUARD_CHILD: "1" },
    });
    process.exitCode = child.status ?? 1;
  }
}
