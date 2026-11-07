/**
 * The grammar of a rule file under ~/.agentbox/rules (INV-1660): the one definition of what
 * may be written in one, which `rules.ts` parses with and `docs/manual/reference-rules.md` is
 * generated from.
 *
 * The syntax used to be described in a comment at the top of rules.ts and read field by field
 * further down; a key added to one and not the other (`agent:` arrived with INV-1664) is a key a
 * person reads about and the parser ignores, or the reverse. Now each frontmatter key is an
 * entry here, with what it matches and how, and architecture-guard refuses a parser that reads
 * a key this table does not have.
 *
 * A leaf: nothing here reads a file or the gate.
 */

/** What a rule does when it matches. Strictest wins: deny, then ask, then allow. */
export const RULE_EFFECTS = ["allow", "ask", "deny"] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

export const EFFECT_MEANS: Record<RuleEffect, string> = {
  allow: "lifts the operator's own approval lists for the call and tells the reviewer it is standing intent; never lifts a host command, the box's irreversible-action finding or the tier gate",
  ask: "forces a person's approval, and names the rule on the consent card",
  deny: "refuses before anyone is asked",
};

/** Which `Rule` property a key fills. */
export type RuleFieldTarget = "name" | "effect" | "tools" | "commands" | "hosts" | "paths" | "principals" | "agents";

export interface RuleField {
  /** The frontmatter key, as written. */
  key: string;
  /** Other spellings the parser accepts for it. */
  aliases: readonly string[];
  target: RuleFieldTarget;
  /** A comma-separated list rather than one value. */
  list: boolean;
  /** Lower-cased when read (hosts). */
  lowercase?: boolean;
  required: boolean;
  /** A matcher: every matcher a rule states must hold for the rule to cover a call. */
  matcher: boolean;
  /** What it means, for the reference page. */
  means: string;
  example: string;
}

export const RULE_FIELDS: readonly RuleField[] = [
  { key: "name", aliases: [], target: "name", list: false, required: false, matcher: false, means: "What the rule is called on a consent card and in the audit; the file name when absent.", example: "jira-comments" },
  { key: "effect", aliases: [], target: "effect", list: false, required: true, matcher: false, means: `One of ${RULE_EFFECTS.join(", ")}.`, example: "allow" },
  { key: "tool", aliases: ["tools"], target: "tools", list: true, required: false, matcher: true, means: "Tool names, or * for any tool.", example: "bash, RunOnHost" },
  { key: "command", aliases: ["commands"], target: "commands", list: true, required: false, matcher: true, means: "For bash / RunOnHost: the command must start with one of these prefixes.", example: "jira comment" },
  { key: "host", aliases: ["hosts"], target: "hosts", list: true, lowercase: true, required: false, matcher: true, means: "For a tool whose input carries a URL (browser_open, WebFetch): the URL's host, exact or *.example.com.", example: "*.atlassian.net" },
  { key: "path", aliases: ["paths"], target: "paths", list: true, required: false, matcher: true, means: "For a tool whose input carries a path (write_file, edit_file): the path is this directory or under it; `~` is the home directory (INV-1700).", example: "~/proj" },
  { key: "principal", aliases: ["principals"], target: "principals", list: true, required: false, matcher: true, means: "Only while the turn runs for one of these people, by principal id or name (INV-156). A turn nobody is attributed to — a schedule, a webhook, a restart — never matches.", example: "Chris" },
  { key: "agent", aliases: ["agents"], target: "agents", list: true, required: false, matcher: true, means: "Only for these agents' own calls, by id or name (INV-1664). A call by any other agent, or by nobody in particular, never matches.", example: "Nova" },
];

/** The body: the standing instruction the reviewer reads. Required, because a rule nobody can read is a rule nobody can follow. */
export const RULE_BODY = "The standing instruction, in words a person and the reviewer can read. Required.";

/** Where rule files live, and what makes a file one. */
export const RULE_FILES = "One Markdown file per rule under ~/.agentbox/rules (AGENTBOX_RULES overrides the directory): `<id>.md`, the file name is the rule's id. Frontmatter between `---` lines, one `key: value` per line, `# comment` allowed after a value; unknown keys are ignored.";

/** How rules decide a call, in order. */
export const RULE_DECISION: readonly string[] = [
  "A rule with no matcher covers no call; its body still reaches the reviewer.",
  "A rule covers a call only when every matcher it states holds.",
  "Of the rules that cover a call, the strictest decides: deny over ask over allow.",
  "An agent's own setting from its Configure dialog (\"ask me\" for a tool or a group) is decided on the same path as a rule scoped to that agent; an \"allow\" there makes no rule, so it never lifts an operator's ask or deny.",
];

export const RULE_EXAMPLE = [
  "---",
  ...RULE_FIELDS.map(field => `${field.key}: ${field.example}`),
  "---",
  "Commenting on a Jira issue is routine work here. Creating or transitioning one is not.",
].join("\n");

/** The value a frontmatter map holds for a field, under its key or an alias. */
export function fieldValue(meta: Readonly<Record<string, string>>, field: RuleField): string | undefined {
  for (const key of [field.key, ...field.aliases]) if (meta[key] !== undefined) return meta[key];
  return undefined;
}

export function ruleField(target: RuleFieldTarget): RuleField {
  const field = RULE_FIELDS.find(f => f.target === target);
  if (field === undefined) throw new Error(`no rule field for ${target}`);
  return field;
}

export function isRuleEffect(value: string): value is RuleEffect {
  return (RULE_EFFECTS as readonly string[]).includes(value);
}

/** The grammar as Markdown, for the generated reference page. */
export function describeGrammar(): string {
  const cell = (value: string) => value.replace(/\|/g, "\\|");
  return [
    RULE_FILES,
    "",
    "## Keys",
    "",
    "| key | also | value | required | matcher | means |",
    "|---|---|---|---|---|---|",
    ...RULE_FIELDS.map(field => `| \`${field.key}\` | ${field.aliases.map(a => `\`${a}\``).join(", ") || "—"} | ${field.list ? "comma-separated list" : "one value"}${field.lowercase ? ", case-insensitive" : ""} | ${field.required ? "yes" : "no"} | ${field.matcher ? "yes" : "no"} | ${cell(field.means)} |`),
    `| body | — | text after the frontmatter | yes | no | ${cell(RULE_BODY)} |`,
    "",
    "## Effects",
    "",
    "| effect | what it does |",
    "|---|---|",
    ...RULE_EFFECTS.map(effect => `| \`${effect}\` | ${cell(EFFECT_MEANS[effect])} |`),
    "",
    "## How a call is decided",
    "",
    ...RULE_DECISION.map((line, i) => `${i + 1}. ${line}`),
    "",
    "## Example",
    "",
    "```markdown",
    RULE_EXAMPLE,
    "```",
    "",
  ].join("\n");
}
