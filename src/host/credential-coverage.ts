/**
 * What a piece of work needs in credentials, and which of those are here — asked before the work
 * starts (INV-1666).
 *
 * Before this the only "what is missing" check ran when a template was imported (docs/53): a task
 * or a routine started blind, and the first anyone heard of a missing key was an agent's "needs a
 * secret" card halfway through — or, for a routine at 03:00, nothing until morning. This is the
 * check, as one pure function the three starting points share:
 *
 * - **what is needed** comes from three statements, never from guessing at the prompt: the agent's
 *   tool list (an entry naming an MCP connector, `mcp:notion__*`), the skills it carries (their
 *   `connectors:` / `secrets:` frontmatter, docs/93 §2 — its own agent-scoped skills and the ones
 *   its box's bundles name) and its box's bundles (`refsFor(...).needs`, INV-421);
 * - **what is here** is read against the vault (Team → Secrets; an OAuth connection is the secret
 *   `oauth:<provider>`, Doors → Connected services) and the live MCP servers and doors
 *   (`connectorSatisfied`, mcp-connectors.ts).
 *
 * A need is `present`, `missing` (with why: not there, or there but not granted to this agent) or
 * `expiring` — the agent's only grant runs out inside EXPIRING_WITHIN_MS, or an OAuth token that
 * the host cannot re-mint does. Expiring is said, not refused: the work can start.
 *
 * Asking is all this does. It never requests a credential and never changes an OAuth flow.
 */

import type { Repository } from "./bundles.ts";
import { connectorSatisfied } from "./mcp-connectors.ts";
import { connectionSecretId, oauthProvider } from "./oauth.ts";
import type { Skill, SkillNeeds } from "./skills.ts";
import { grantCovers, type SecretView } from "./vault.ts";

/** The machine word a routine's skip and hold carry when this check stops it (routine-runs.ts). */
export const MISSING_CREDENTIALS = "missing_credentials";

/** How close an expiry has to be before a run is told about it. */
export const EXPIRING_WITHIN_MS = 3 * 24 * 3_600_000;

/** What a task waiting on this check says in its `waitingOn`, so the release can find it again. */
export const CREDENTIALS_WAITING_PREFIX = "credentials:";

export interface CredentialNeed {
  kind: "secret" | "connector";
  /** A vault secret id, or a connector name as written (`github`, `mcp:notion`). */
  id: string;
  /** Who said it is needed: "Ada's tools", "skill weekly-report", "bundle github-rw". */
  by: string[];
}

export type CoverageState = "present" | "missing" | "expiring";

export interface CoverageItem extends CredentialNeed {
  state: CoverageState;
  /** One line a person reads: why it is missing or expiring, or what satisfies it. */
  why: string;
  /** Where a person fixes it: the settings tab and its words. */
  where: { tab: "team" | "doors"; label: string };
  expiresAt?: string;
}

export interface Coverage {
  /** Nothing missing. Expiring items do not stop work. */
  ok: boolean;
  items: CoverageItem[];
}

/** The agent as this check reads it: who it is, its tool list, and its box's bundle needs. */
export interface CoverageAgent {
  id: string;
  name: string;
  principalId?: string;
  tools?: readonly string[];
  bundles?: readonly { name: string; needs: { connectors?: string[]; secretIds?: string[]; skills?: string[]; repositories?: Repository[] } }[];
}

export type CoverageSkill = Pick<Skill, "slug" | "name"> & { needs?: SkillNeeds };

/** What is here. Passed in, never read from the process, so a test is the world it says. */
export interface CoverageWorld {
  secrets: readonly SecretView[];
  /** Names of the configured MCP servers (config.json and live doors). */
  servers: readonly string[];
  /** The environment the doors are gated on. */
  env: Readonly<Record<string, string | undefined>>;
  /** Names that count as connected without a credential here: `browser`, the channel types. */
  connected?: readonly string[];
  /** True when the agent's box's bundles grant this secret (BundleStore.grantsSecret). */
  bundleGrants?: (secretId: string) => boolean;
  now?: Date;
}

/**
 * The skills an agent carries into any task: its own agent-scoped ones, and the ones its box's
 * bundles name. A global skill is everybody's and nobody's — its needs are checked when it runs
 * as a routine, not before every task of every agent.
 */
export function mountedSkills<S extends CoverageSkill & { scope?: string; owner?: string }>(skills: readonly S[], agent: CoverageAgent): S[] {
  const named = new Set((agent.bundles ?? []).flatMap(bundle => bundle.needs.skills ?? []));
  return skills.filter(skill => (skill.scope === "agent" && skill.owner === agent.name) || named.has(skill.slug));
}

/** The connector a tool-list entry names, when it names one: `mcp:notion__search` → `mcp:notion`. */
function connectorOfTool(entry: string): string | undefined {
  if (!entry.startsWith("mcp:")) return undefined;
  const at = entry.indexOf("__");
  return at < 0 ? entry : entry.slice(0, at);
}

/** Every credential the agent and these skills need, each with who said so. */
export function needsOf(agent: CoverageAgent, skills: readonly CoverageSkill[]): CredentialNeed[] {
  const needs = new Map<string, CredentialNeed>();
  const add = (kind: CredentialNeed["kind"], id: string, by: string) => {
    const key = `${kind}:${kind === "connector" ? connectorKey(id) : id}`;
    const need = needs.get(key) ?? { kind, id, by: [] };
    if (!need.by.includes(by)) need.by.push(by);
    needs.set(key, need);
  };
  for (const entry of agent.tools ?? []) {
    const connector = connectorOfTool(entry);
    if (connector !== undefined) add("connector", connector, `${agent.name}'s tools`);
  }
  for (const bundle of agent.bundles ?? []) {
    for (const connector of bundle.needs.connectors ?? []) add("connector", connector, `bundle ${bundle.name}`);
    for (const secret of bundle.needs.secretIds ?? []) add("secret", secret, `bundle ${bundle.name}`);
  }
  for (const skill of skills) {
    for (const connector of skill.needs?.connectors ?? []) add("connector", connector, `skill ${skill.slug}`);
    for (const secret of skill.needs?.secrets ?? []) add("secret", secret, `skill ${skill.slug}`);
  }
  return [...needs.values()];
}

/** `github`, `oauth:github` and `mcp:github` are one connector to a person. */
function connectorKey(name: string): string {
  return name.trim().toLowerCase().replace(/^(mcp|oauth):/, "");
}

const SECRETS_WHERE = { tab: "team", label: "Settings → Team → Secrets" } as const;
const SERVICES_WHERE = { tab: "doors", label: "Settings → Doors → Connected services" } as const;

/**
 * Whether one vault secret is usable by this agent now: there, covered by a live grant (or the
 * box's bundle), and not about to lapse with nobody able to re-mint it.
 */
function secretState(
  id: string,
  agent: CoverageAgent,
  world: CoverageWorld,
  now: Date
): { state: CoverageState; why: string; expiresAt?: string } | undefined {
  const secret = world.secrets.find(entry => entry.id === id);
  if (secret === undefined) return undefined;
  const caller = { agentId: agent.id, ...(agent.principalId !== undefined ? { principalId: agent.principalId } : {}) };
  const viaBundle = world.bundleGrants?.(id) === true;
  const live = secret.grants.filter(grant => grantCovers(grant, caller, now.getTime()));
  if (!viaBundle && live.length === 0) {
    return { state: "missing", why: `${id} is here but not granted to ${agent.name}` };
  }
  // The grant that lasts longest decides; one without an expiry, or the bundle's, never lapses.
  const lasting = viaBundle || live.some(grant => grant.expiresAt === undefined);
  const grantEnds = lasting ? undefined : live.map(grant => grant.expiresAt!).sort().at(-1);
  const tokenEnds = secret.oauth?.refreshable === true ? undefined : secret.oauth?.expiresAt;
  if (tokenEnds !== undefined && Date.parse(tokenEnds) <= now.getTime()) {
    return { state: "missing", why: `the ${secret.oauth!.provider} token expired ${tokenEnds.slice(0, 16).replace("T", " ")} and cannot be renewed here`, expiresAt: tokenEnds };
  }
  const ends = [grantEnds, tokenEnds].filter((at): at is string => at !== undefined).sort()[0];
  if (ends !== undefined && Date.parse(ends) - now.getTime() <= EXPIRING_WITHIN_MS) {
    return { state: "expiring", why: `${ends === tokenEnds ? "its token" : `${agent.name}'s grant`} runs out ${ends.slice(0, 16).replace("T", " ")}`, expiresAt: ends };
  }
  return { state: "present", why: viaBundle && live.length === 0 ? `granted through the box's bundle` : "granted" };
}

function connectorItem(need: CredentialNeed, agent: CoverageAgent, world: CoverageWorld, now: Date): CoverageItem {
  const bare = connectorKey(need.id);
  const connected = new Set((world.connected ?? []).map(name => name.toLowerCase()));
  if (connected.has(need.id.toLowerCase()) || connected.has(bare)) return { ...need, state: "present", why: "connected", where: SERVICES_WHERE };
  const slug = need.id.startsWith("mcp:") ? need.id : `mcp:${bare}`;
  if (connectorSatisfied(slug, world.servers, world.env as NodeJS.ProcessEnv)) return { ...need, state: "present", why: "an MCP server answers for it", where: SERVICES_WHERE };
  const oauth = secretState(connectionSecretId(bare), agent, world, now);
  if (oauth !== undefined) return { ...need, ...oauth, where: SERVICES_WHERE };
  const provider = oauthProvider(bare);
  return {
    ...need,
    state: "missing",
    why: provider !== undefined ? `${provider.title} is not connected here` : `${need.id} is not connected here (no MCP server or door answers for it)`,
    where: SERVICES_WHERE,
  };
}

/**
 * The coverage of what `agent` and `skills` need against what `world` has. One item per need, in
 * the order the needs were stated; `ok` is false when any is missing.
 */
export function credentialCoverage(agent: CoverageAgent, skills: readonly CoverageSkill[], world: CoverageWorld): Coverage {
  const now = world.now ?? new Date();
  const items = needsOf(agent, skills).map((need): CoverageItem => {
    if (need.kind === "connector") return connectorItem(need, agent, world, now);
    const state = secretState(need.id, agent, world, now);
    return state === undefined ? { ...need, state: "missing", why: `there is no secret ${need.id}`, where: SECRETS_WHERE } : { ...need, ...state, where: SECRETS_WHERE };
  });
  return { ok: items.every(item => item.state !== "missing"), items };
}

/** The missing items as one line: what a routine's skip, a task's `waitingOn` and a chat hear. */
export function missingLine(coverage: Coverage): string {
  return coverage.items
    .filter(item => item.state === "missing")
    .map(item => `${item.kind === "connector" ? "connector" : "secret"} ${item.id} (${item.why}; ${item.where.label}; needed by ${item.by.join(", ")})`)
    .join("; ");
}

/**
 * What a chat hears instead of the work starting: each missing item, where it is set, and that the
 * same task starts by itself once it is. Chinese, like every other line the channels send.
 */
export function beforeStartText(coverage: Coverage, agentName: string): string {
  const lines = coverage.items
    .filter(item => item.state === "missing")
    .map(item => `· ${item.kind === "connector" ? "连接" : "密钥"} ${item.id}：${item.why}（在 ${item.where.label} 配置；${item.by.join("、")} 需要）`);
  return [`${agentName} 开始前需要：`, ...lines, "配好后这条任务会自动开始，不用再发一遍。"].join("\n");
}

/**
 * For the Secrets list (Settings → Team): which agents and skills need each vault secret, by id. A
 * connector need lands on its OAuth secret (`github` → `oauth:github`), the row a person removes.
 */
export function neededBy(
  agents: readonly { agent: CoverageAgent; skills: readonly CoverageSkill[] }[],
  skills: readonly CoverageSkill[] = []
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (id: string, who: string) => {
    const list = out[id] ?? [];
    if (!list.includes(who)) list.push(who);
    out[id] = list;
  };
  const idOf = (need: CredentialNeed) => (need.kind === "secret" ? need.id : connectionSecretId(connectorKey(need.id)));
  for (const { agent, skills: carried } of agents) {
    for (const need of needsOf(agent, carried)) add(idOf(need), agent.name);
  }
  for (const skill of skills) {
    for (const need of needsOf({ id: "", name: "" }, [skill])) add(idOf(need), `skill ${skill.slug}`);
  }
  return out;
}
