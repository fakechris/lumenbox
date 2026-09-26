/**
 * Rules about where things may live, checked against the sources rather than remembered.
 *
 * Each rule below was once a comment somebody was expected to have read. A guard that
 * scans the tree turns "we agreed" into "the build says" (TurnkeyAI's architecture-guard
 * test is the pattern; the rules are ours).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");

function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "catalog-data" || name === "node_modules") continue;
        walk(full);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        out.push({ path: relative(ROOT, full), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(ROOT);
  return out;
}

test("ledgers append through jsonl.ts, which syncs; raw appends stay where they were", () => {
  // These two predate the rule and keep their own reasons (vault audit with mode 0600,
  // the activity feed as a best-effort log). Anything new appends through appendLine.
  const allowed = new Set(["host/jsonl.ts", "host/vault.ts", "web/activity.ts"]);
  const offenders = sources()
    .filter(file => /\bappendFileSync\(/.test(file.text) && !allowed.has(file.path))
    .map(file => file.path);
  assert.deepEqual(offenders, [], "a new raw appendFileSync: use appendLine from jsonl.ts");
});

test("a reader that cuts what it read says so through read-outcome.ts, not in its own prose", () => {
  // Six readers used to each describe a cut in their own words, at the end of the result —
  // where the transcript's 2,000-character cut throws it away first (docs/69). The wording
  // now lives in one place and goes first. A seventh phrasing is a regression, so the
  // build refuses it.
  const phrases = /rest of (?:the )?(?:page|post|document) not shown|showing part of|已截断|the \d+ most recent are above/;
  const offenders = sources()
    .filter(file => file.path.startsWith("host/") || file.path.startsWith("channels/"))
    .filter(file => phrases.test(file.text))
    .filter(file => !/read-outcome|withReadOutcome|readOutcome/.test(file.text))
    .map(file => file.path);
  assert.deepEqual(
    offenders,
    [],
    "a truncation notice written by hand: build it with readOutcome() from read-outcome.ts and put it first"
  );
});

test("the policy gate is asked from the few places that act, and nowhere else", () => {
  // The orchestrator also makes the tool-free teaching proposal call: it must ask
  // the same stop/budget gate even though no ordinary tool-enabled turn is started.
  const allowed = new Set(["cli.ts", "host/mcp-face.ts", "host/tools.ts", "host/turn.ts", "host/orchestrator.ts", "web/server.ts"]);
  const offenders = sources()
    .filter(file => /\.check\(\{\s*kind:/.test(file.text) && !allowed.has(file.path))
    .map(file => file.path);
  assert.deepEqual(offenders, [], "a new caller of policy.check: add it here on purpose, with the reason");
});

test("an engine skips permissions only where presets.ts decides so", () => {
  const offenders = sources()
    .filter(file => file.text.includes("--dangerously-skip-permissions") && file.path !== "host/presets.ts")
    .map(file => file.path);
  assert.deepEqual(offenders, []);
});

test("policy limits are never read at module load", () => {
  // The bug of 2026-09-07: a constant built from process.env at import time, before the
  // config's env block landed. Only defaultLimits() may read those variables.
  const offenders = sources()
    .filter(file => file.path !== "host/policy.ts" && /AGENTBOX_APPROVAL_(TOOLS|COMMANDS)/.test(file.text))
    .filter(file => !/absences\.ts|config\.ts/.test(file.path))
    .map(file => file.path);
  assert.deepEqual(offenders, []);
});

test("an agent is created into a named box, or beside its creator — never by default", () => {
  // The bug of 2026-09-08: an agent on the attached VM created teammates that landed in
  // the Docker box because the call named no box. The registry resolves `beside` to the
  // creator's box; a call that passes neither is an install-time site and is listed here.
  const allowed = new Set([
    "cli.ts:STARTER_TEAM", "cli.ts:golden", "host/orchestrator.ts:STARTER_TEAM",
  ]);
  const offenders: string[] = [];
  for (const file of sources()) {
    if (file.path === "agents/registry.ts") continue;
    let from = 0;
    for (;;) {
      const at = file.text.indexOf("registry.create(", from);
      if (at < 0) break;
      // The whole argument list, parentheses balanced, so a call spanning lines and nested
      // calls is read to its real end rather than to the first ')'.
      let depth = 0, end = at + "registry.create".length;
      for (; end < file.text.length; end += 1) {
        const ch = file.text[end];
        if (ch === "(") depth += 1;
        else if (ch === ")") { depth -= 1; if (depth === 0) break; }
      }
      const args = file.text.slice(at, end + 1);
      from = end + 1;
      const before = file.text.slice(Math.max(0, at - 80), at);
      if (/boxId|beside/.test(args)) continue;
      if (/STARTER_TEAM/.test(before + args) && allowed.has(`${file.path}:STARTER_TEAM`)) continue;
      if (/"Gold"|"Silver"/.test(args) && allowed.has(`${file.path}:golden`)) continue;
      offenders.push(`${file.path}: ${args.replace(/\s+/g, " ").slice(0, 70)}`);
    }
  }
  assert.deepEqual(offenders, [], "a registry.create with no box: pass boxId, or beside: <creator id>");
});

test("only the two places that cut a tool result may know how long a stored one may be", () => {
  // The defect of 2026-09-22 (INV-633): the trim to DURABLE_RESULT_CHARS happens in one
  // place, `storableResult`, and that is now also the place that keeps what it trims
  // (results.ts). A third file importing the constant would either be trimming a result
  // without keeping it — the same silent loss again, one tool at a time — or building a
  // second, divergent idea of how much survives.
  //
  // By import rather than by mention: a comment explaining the limit is how the reasoning
  // travels, and forbidding the words would only teach people to paraphrase them.
  const allowed = new Set([
    "protocol/index.ts", // declares it
    "host/turn.ts", // storableResult: cuts, and keeps what it cut
    "boxd/shell-service.ts", // the box spills at the same threshold, before the host sees it
  ]);
  const offenders = sources()
    .filter(file => !allowed.has(file.path))
    .filter(file => /^\s*import[^;]*\bDURABLE_RESULT_CHARS\b/m.test(file.text))
    .map(file => file.path);
  assert.deepEqual(
    offenders,
    [],
    "cut a tool result in storableResult, which keeps the whole of it, or do not cut it"
  );
});

test("a ledger that compacts says what kind of thing it is, and a record archives", () => {
  // The defect of 2026-09 (INV-634): eight files compacted and none of them said which of
  // four things it was, so each `compact()` was written by copying whichever neighbour was
  // open. Two that described themselves in prose as records of what happened — every
  // arrival at a door and its fate, the life of every turn — were compacted as queues, and
  // lost everything settled. Both losses were silent and both were total.
  //
  // So the kind is declared where the file is written, and `record` binds compaction to
  // archive rather than drop.
  const ledgers = sources().filter(file => /\n\s*private compact\(/.test(file.text));
  assert.ok(ledgers.length >= 9, `expected to find the ledgers, found ${ledgers.length}`);

  const undeclared = ledgers
    .filter(file => !/export const LEDGER_KIND: LedgerKind = "(record|queue|state|feed)"/.test(file.text))
    .map(file => file.path);
  assert.deepEqual(
    undeclared,
    [],
    'a file with compact() must declare export const LEDGER_KIND: LedgerKind = "record" | "queue" | "state" | "feed" (jsonl.ts)'
  );

  // A record's compact() must hand its settled lines to the archive. Checked on the body
  // of the method rather than on the file, so calling archiveSettled somewhere else does
  // not satisfy it.
  const droppers: string[] = [];
  for (const file of ledgers) {
    if (!/LEDGER_KIND: LedgerKind = "record"/.test(file.text)) continue;
    const at = file.text.search(/\n\s*private compact\(/);
    let depth = 0;
    let end = file.text.indexOf("{", at);
    const start = end;
    for (; end < file.text.length; end += 1) {
      const ch = file.text[end];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (!file.text.slice(start, end).includes("archiveSettled(")) droppers.push(file.path);
  }
  assert.deepEqual(droppers, [], "a record's compact() must call archiveSettled — a record may move a line, never lose one");
});

test("a message's id is minted at the door, or inherited — never invented downstream", () => {
  // The defect INV-613 fixed, kept fixed. The channel manager mints the id the moment a
  // message is admitted and writes it to messages.jsonl; the bus takes that id and only
  // mints one when there was no door (the web, a routine, a teammate). A third minting
  // site means two ids for one message, which is how the chain from what a person said to
  // the turn it caused came apart the first time.
  //
  // Scoped to the two layers a message travels through. Elsewhere a uuid is a box id, a
  // job id, a session token — none of them a message.
  const allowed = new Set([
    "channels/manager.ts", // at admission, beside the messages.jsonl line
    "agents/bus.ts", // sendFromUser's fallback, for messages that came through no door
    "agents/registry.ts", // agent ids, which are not messages
  ]);
  const offenders = sources()
    .filter(file => file.path.startsWith("channels/") || file.path.startsWith("agents/"))
    .filter(file => !allowed.has(file.path))
    .filter(file => /\brandomUUID\b/.test(file.text))
    .map(file => file.path);
  assert.deepEqual(offenders, [], "carry the id the door minted; do not mint a second one for the same message");
});

test("what a tool does to the world is declared in side-effects.ts and nowhere else (INV-691)", () => {
  // The table this replaced sat in tools.ts, was read by nothing, and named a tool that did not
  // exist. A second declaration would drift from the first the same way.
  const tier = /\btier:\s*"(?:observe|self|reach|spend|credential)"/;
  const elsewhere = sources()
    .filter(file => file.path !== "host/side-effects.ts" && tier.test(file.text))
    .map(file => file.path);
  assert.deepEqual(elsewhere, [], "declare a tool's effect in src/host/side-effects.ts");
});

test("Claude Code's tool names map to ours in engine-tools.ts only (INV-691)", () => {
  // mcp-face.ts had its own four-line mapping; skills.ts grew a second. One table now.
  const table = /\bmultiedit\b["']?\s*:|\bMultiEdit\b["']?\s*:/;
  const elsewhere = sources()
    .filter(file => file.path !== "host/engine-tools.ts" && table.test(file.text))
    .map(file => file.path);
  assert.deepEqual(elsewhere, [], "map an engine tool name in src/host/engine-tools.ts");
});

test("a login's next is checked by safeNext in web/auth.ts and nowhere else (INV-724)", () => {
  // The box and the control-plane gateway each had their own check, and each missed a different
  // way a browser leaves the origin (`/\`, then tab). A third hand-rolled `startsWith("//")`
  // check would be the same bug again.
  const handRolled = /\.startsWith\(\s*["']\/\/["']\s*\)/;
  // The pattern has to catch what it is for, or the empty list below proves nothing.
  assert.ok(handRolled.test(`const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";`));
  // tools.ts checks a connector_request path, which is appended to a fixed API base after its
  // host — a leading "/" already ends the authority, so it is not a redirect and cannot leave it.
  const allowed = new Set(["web/auth.ts", "host/tools.ts"]);
  const elsewhere = sources()
    .filter(file => !allowed.has(file.path) && handRolled.test(file.text))
    .map(file => file.path);
  assert.deepEqual(elsewhere, [], "check a redirect target with safeNext from src/web/auth.ts");
});
