/**
 * Operator rules: parsed from files, matched by their stated matchers, strictest wins,
 * rendered for the reviewer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleStore, decidingRule, parseRuleFile, ruleMatches, renderRulesForReview } from "./rules.ts";

const file = (meta: string, body = "Because we said so.") => `---\n${meta}\n---\n${body}\n`;

test("a rule file needs frontmatter, a known effect and a body", () => {
  assert.match(parseRuleFile("x", "no frontmatter").problem ?? "", /no frontmatter/);
  assert.match(parseRuleFile("x", file("effect: maybe")).problem ?? "", /effect must be allow, ask or deny/);
  assert.match(parseRuleFile("x", file("effect: allow", "")).problem ?? "", /body is empty/);
  const rule = parseRuleFile("jira", file("name: Jira comments\neffect: allow\ntool: bash, RunOnHost\ncommand: jira comment, jira issue view  # prefixes\nhost: *.Atlassian.net")).rule!;
  assert.equal(rule.name, "Jira comments");
  assert.deepEqual(rule.tools, ["bash", "RunOnHost"]);
  assert.deepEqual(rule.commands, ["jira comment", "jira issue view"]);
  assert.deepEqual(rule.hosts, ["*.atlassian.net"]);
  assert.equal(rule.text, "Because we said so.");
  // No name: the file name is the name.
  assert.equal(parseRuleFile("nameless", file("effect: deny")).rule?.name, "nameless");
});

test("every matcher a rule states must hold; a rule with none matches nothing structurally", () => {
  const rule = parseRuleFile("r", file("effect: allow\ntool: bash\ncommand: jira comment")).rule!;
  assert.equal(ruleMatches(rule, "bash", { command: "jira comment --issue X-1 'ok'" }), true);
  assert.equal(ruleMatches(rule, "bash", { command: "jira issue delete X-1" }), false);
  assert.equal(ruleMatches(rule, "RunOnHost", { command: "jira comment" }), false, "tool must match");
  const any = parseRuleFile("r", file("effect: deny\ntool: *\ncommand: rm -rf")).rule!;
  assert.equal(ruleMatches(any, "RunOnHost", { command: "rm -rf /" }), true);
  const host = parseRuleFile("r", file("effect: allow\nhost: *.example.com")).rule!;
  assert.equal(ruleMatches(host, "browser_open", { url: "https://api.example.com/x" }), true);
  assert.equal(ruleMatches(host, "browser_open", { url: "https://evilexample.com/x" }), false);
  assert.equal(ruleMatches(host, "browser_act", { ref: "e1" }), false, "no URL, no host match");
  const textOnly = parseRuleFile("r", file("effect: deny")).rule!;
  assert.equal(ruleMatches(textOnly, "bash", { command: "anything" }), false);
});

test("the strictest matching rule decides: deny over ask over allow", () => {
  const rules = [
    parseRuleFile("allow-git", file("effect: allow\ntool: bash\ncommand: git")).rule!,
    parseRuleFile("ask-push", file("effect: ask\ntool: bash\ncommand: git push")).rule!,
    parseRuleFile("deny-force", file("effect: deny\ntool: bash\ncommand: git push --force")).rule!,
  ];
  assert.equal(decidingRule(rules, "bash", { command: "git status" })?.id, "allow-git");
  assert.equal(decidingRule(rules, "bash", { command: "git push origin main" })?.id, "ask-push");
  assert.equal(decidingRule(rules, "bash", { command: "git push --force origin main" })?.id, "deny-force");
  assert.equal(decidingRule(rules, "bash", { command: "ls" }), undefined);
  assert.deepEqual(renderRulesForReview(rules.slice(0, 1)), ["[allow-git] (allow) Because we said so."]);
});

test("the store reads a directory, reports what it ignored, and tells its listener when the set changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-rules-"));
  try {
    const changes: { hash: string; ids: string[] }[] = [];
    writeFileSync(join(dir, "a.md"), file("effect: allow\ntool: bash\ncommand: ls"));
    writeFileSync(join(dir, "broken.md"), "not a rule");
    writeFileSync(join(dir, "notes.txt"), "ignored by extension");
    const store = new RuleStore(dir, change => changes.push({ hash: change.hash, ids: change.ids }));
    assert.deepEqual(store.list().map(r => r.id), ["a"]);
    assert.deepEqual(store.ignored().map(p => p.id), ["broken"]);
    assert.equal(changes.length, 1);
    store.reload();
    assert.equal(changes.length, 1, "an unchanged set is not announced again");
    writeFileSync(join(dir, "b.md"), file("effect: deny\ntool: *\ncommand: rm -rf"));
    store.reload();
    assert.equal(changes.length, 2);
    assert.deepEqual(changes[1]?.ids, ["a", "b"]);
    assert.equal(store.decide("bash", { command: "rm -rf /tmp/x" })?.effect, "deny");
    const empty = new RuleStore(join(dir, "nope"));
    assert.deepEqual(empty.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rule can be written about one person, and an unattributed turn never inherits it (INV-156)", () => {
  // The scene: Chris pre-authorises his own routine push. Mia's identical command still
  // asks, and the nightly routine — which nobody drove — asks too, because a standing
  // allowance a person gave is not the machine's to pick up when it acts on its own.
  const { rule: mine } = parseRuleFile("chris-push", [
    "---",
    "name: chris pushes his own branches",
    "effect: allow",
    "tool: bash",
    "command: git push",
    "principal: Chris",
    "---",
    "Chris pushes feature branches all day; asking each time teaches him to click yes without reading.",
  ].join("\n"));
  assert.ok(mine);
  assert.deepEqual(mine.principals, ["Chris"]);

  const input = { command: "git push origin HEAD" };
  assert.equal(ruleMatches(mine, "bash", input, { name: "Chris" }), true);
  assert.equal(ruleMatches(mine, "bash", input, { id: "p-chris", name: "chris" }), true, "the name matches whatever its case");
  assert.equal(ruleMatches(mine, "bash", input, { name: "Mia" }), false, "somebody else's identical command still asks");
  assert.equal(ruleMatches(mine, "bash", input, undefined), false, "a schedule, a webhook or a restart inherits nothing");
  assert.equal(ruleMatches(mine, "bash", { command: "git tag v1" }, { name: "Chris" }), false, "and it is still about the command");

  // Matching by id, for a rule written where names are not stable.
  const { rule: byId } = parseRuleFile("by-id", ["---", "effect: allow", "tool: bash", "principal: p-chris", "---", "The same, keyed by id."].join("\n"));
  assert.ok(byId);
  assert.equal(ruleMatches(byId, "bash", input, { id: "p-chris" }), true);
  assert.equal(ruleMatches(byId, "bash", input, { id: "p-mia", name: "Mia" }), false);

  // A rule with nobody named is everyone's, as every rule written before this was.
  const { rule: everyones } = parseRuleFile("everyone", ["---", "effect: allow", "tool: bash", "command: git push", "---", "Anyone here may push."].join("\n"));
  assert.ok(everyones);
  assert.deepEqual(everyones.principals, []);
  assert.equal(ruleMatches(everyones, "bash", input, undefined), true);
  assert.equal(ruleMatches(everyones, "bash", input, { name: "Mia" }), true);

  // Severity still decides between two matching rules, and the reviewer's line says whose.
  const { rule: refuse } = parseRuleFile("never-force", ["---", "effect: deny", "tool: bash", "command: git push --force", "---", "Never force-push here."].join("\n"));
  assert.ok(refuse);
  const chosen = decidingRule([mine, refuse], "bash", { command: "git push --force origin main" }, { name: "Chris" });
  assert.equal(chosen?.id, "never-force", "a deny outranks a person's own allowance");
  assert.deepEqual(renderRulesForReview([mine, everyones]), [
    "[chris-push] (allow for Chris) Chris pushes feature branches all day; asking each time teaches him to click yes without reading.",
    "[everyone] (allow) Anyone here may push.",
  ]);
});
