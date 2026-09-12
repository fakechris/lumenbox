/**
 * Operator rules: what the people who run this place have decided in advance about what
 * an agent may do without asking (INV-427, docs/50 I1; Claude Tag's auto-mode allow rules).
 *
 * Today's approvals are answers: a person is asked, says yes once, for the session, or
 * always, and the grant is bound to the exact action shown. That is right for the
 * unforeseen and wrong for the routine — a team that lets bots write Jira comments does
 * not want to click "allow" per comment, and a team that never lets a bot delete a
 * branch does not want to rely on the model's judgement each time. Rules are the third
 * thing: written once by an administrator, applied before any model, audited by id.
 *
 * One Markdown file per rule under ~/.agentbox/rules. Frontmatter carries the matchers
 * and the effect; the body is what the reviewer reads as a standing instruction:
 *
 *     ---
 *     name: jira-comments
 *     effect: allow            # allow | ask | deny
 *     tool: bash, RunOnHost    # optional; names, or * for any
 *     command: jira comment    # optional; the command must start with one of these
 *     host: *.atlassian.net    # optional; for browser_open / WebFetch, the URL's host
 *     ---
 *     Commenting on a Jira issue is routine work here. Creating or transitioning one is not.
 *
 * What an `allow` may and may not do is the whole design: it lifts the operator's *own*
 * configured approval lists and tells the reviewer the operator's standing intent. It
 * never lifts what is not the operator's to lift — a host command always asks (docs/08),
 * and the box's irreversible-action finding (INV-401) always asks. `deny` refuses before
 * anyone is consulted; `ask` forces an approval and names the rule on the card.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../config.ts";

export type RuleEffect = "allow" | "ask" | "deny";

export interface Rule {
  id: string;
  name: string;
  effect: RuleEffect;
  /** Tool names, or ["*"]. Empty means the rule has no structured matcher. */
  tools: string[];
  /** Command prefixes for bash / RunOnHost. */
  commands: string[];
  /** Hosts, exact or `*.example.com`, for tools whose input carries a URL. */
  hosts: string[];
  /** The standing instruction, as the reviewer reads it. */
  text: string;
}

export function rulesDir(): string {
  return process.env.AGENTBOX_RULES ?? join(agentboxHome(), "rules");
}

const list = (value: string | undefined): string[] =>
  value === undefined ? [] : value.split(",").map(entry => entry.trim()).filter(entry => entry !== "");

/** One rule file, or undefined with a reason when it cannot be one. */
export function parseRuleFile(id: string, content: string): { rule?: Rule; problem?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content.replace(/^﻿/, ""));
  if (match === null) return { problem: "no frontmatter (--- name/effect ---)" };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    meta[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).replace(/\s+#.*$/, "").trim();
  }
  const effect = (meta.effect ?? "").toLowerCase();
  if (effect !== "allow" && effect !== "ask" && effect !== "deny") return { problem: `effect must be allow, ask or deny (got ${JSON.stringify(meta.effect ?? "")})` };
  const text = match[2]!.trim();
  if (text === "") return { problem: "the body is empty; say what the rule means, in words a person and a reviewer can read" };
  return {
    rule: {
      id,
      name: meta.name?.trim() !== "" && meta.name !== undefined ? meta.name.trim() : id,
      effect,
      tools: list(meta.tool ?? meta.tools),
      commands: list(meta.command ?? meta.commands),
      hosts: list(meta.host ?? meta.hosts).map(host => host.toLowerCase()),
      text,
    },
  };
}

function hostMatches(host: string, patterns: readonly string[]): boolean {
  const target = host.toLowerCase();
  return patterns.some(pattern => (pattern.startsWith("*.") ? target === pattern.slice(2) || target.endsWith(pattern.slice(1)) : target === pattern));
}

function hostOfInput(input: Record<string, unknown>): string | undefined {
  const url = typeof input.url === "string" ? input.url : undefined;
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Whether a rule's structured matchers cover a call. A rule with no matchers covers nothing
 * here — its text still reaches the reviewer — and every matcher a rule states must hold.
 */
export function ruleMatches(rule: Rule, tool: string, input: Record<string, unknown>): boolean {
  if (rule.tools.length === 0 && rule.commands.length === 0 && rule.hosts.length === 0) return false;
  if (rule.tools.length > 0 && !rule.tools.includes("*") && !rule.tools.includes(tool)) return false;
  if (rule.commands.length > 0) {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (command === "" || !rule.commands.some(prefix => command.startsWith(prefix))) return false;
  }
  if (rule.hosts.length > 0) {
    const host = hostOfInput(input);
    if (host === undefined || !hostMatches(host, rule.hosts)) return false;
  }
  return true;
}

const SEVERITY: Record<RuleEffect, number> = { deny: 3, ask: 2, allow: 1 };

/** The rule that decides a call: the strictest of those that match. */
export function decidingRule(rules: readonly Rule[], tool: string, input: Record<string, unknown>): Rule | undefined {
  let chosen: Rule | undefined;
  for (const rule of rules) {
    if (!ruleMatches(rule, tool, input)) continue;
    if (chosen === undefined || SEVERITY[rule.effect] > SEVERITY[chosen.effect]) chosen = rule;
  }
  return chosen;
}

/** The rules as the reviewer reads them: a numbered list of standing instructions. */
export function renderRulesForReview(rules: readonly Rule[]): string[] {
  return rules.map(rule => `[${rule.id}] (${rule.effect}) ${rule.text}`);
}

export class RuleStore {
  private rules: Rule[] = [];
  private problems: { id: string; problem: string }[] = [];
  private hash = "";

  constructor(
    private readonly dir: string = rulesDir(),
    /** Told once when the set of rules changes, with what it became — the audit row. */
    private readonly onChange: (change: { hash: string; ids: string[]; problems: { id: string; problem: string }[] }) => void = () => {},
    private readonly log: (line: string) => void = () => {}
  ) {
    this.reload();
  }

  reload(): void {
    const rules: Rule[] = [];
    const problems: { id: string; problem: string }[] = [];
    if (existsSync(this.dir)) {
      for (const name of readdirSync(this.dir).filter(n => n.endsWith(".md")).sort()) {
        const id = name.slice(0, -".md".length);
        let content: string;
        try {
          content = readFileSync(join(this.dir, name), "utf8");
        } catch {
          problems.push({ id, problem: "unreadable" });
          continue;
        }
        const parsed = parseRuleFile(id, content);
        if (parsed.rule !== undefined) rules.push(parsed.rule);
        else problems.push({ id, problem: parsed.problem ?? "invalid" });
      }
    }
    const hash = createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 16);
    const changed = hash !== this.hash;
    this.rules = rules;
    this.problems = problems;
    this.hash = hash;
    for (const problem of problems) this.log(`rule ${problem.id} ignored: ${problem.problem}`);
    if (changed) this.onChange({ hash, ids: rules.map(rule => rule.id), problems });
  }

  list(): Rule[] {
    return this.rules.map(rule => ({ ...rule }));
  }

  /** Files that are not rules, so an operator finds out without grepping a log. */
  ignored(): { id: string; problem: string }[] {
    return [...this.problems];
  }

  decide(tool: string, input: Record<string, unknown>): Rule | undefined {
    return decidingRule(this.rules, tool, input);
  }

  forReview(): string[] {
    return renderRulesForReview(this.rules);
  }
}
