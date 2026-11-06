/**
 * An agent's configuration has versions (INV-1669): every Configure save is one, numbered from 1,
 * with when and who; "go back to this version" makes a new one and rewrites none. Each turn
 * records the version it began under, and that version is the one it runs under to its end.
 *
 * What a version holds is what a person sets about an agent: its persona, the tools it is offered
 * ("off" is `tools`), what it asks before (`toolPermissions`, INV-1664), its provider, model,
 * fallbacks and scope — and a hash per standing file (AGENTS / SOUL / USER / HEARTBEAT) as the
 * last turn read them. Those files live in the box and are not versioned here: the hash says
 * *that* one changed and when, which is the pointer a person follows to the box's own copy. The
 * name and the teams are not configuration: the name is how the others address it, and team
 * membership is the registry's.
 *
 * **A running turn keeps the version it began with.** The tool list it was offered and the model
 * it runs on were always fixed at the start; the ask-before setting, read on every call, now reads
 * the turn's version too (`permissionsInEffect`). So a change in Configure applies from the next
 * turn, in both directions, and the version a turn records is the one it was actually held to —
 * otherwise "it changed after I edited this" would point at the wrong version. Stopping what is
 * running now is the Stop button's and the agent pause's (INV-1554), not a settings save's.
 *
 * Stored per agent beside its profile, `<agent dir>/config-versions.jsonl`: a `version` line per
 * version, and a `use` line whenever a conversation or a task starts running under a version it was
 * not already running under — the switch points the task detail and the conversation header list.
 * Never compacted: it grows by a line per save and per switch, not per turn.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLine } from "../host/jsonl.ts";
import type { ToolGroup, ToolPermission, ToolPermissions } from "../host/tool-permissions.ts";

export const CONFIG_VERSIONS_FILENAME = "config-versions.jsonl";

export type StandingHashes = Partial<Record<"AGENTS" | "SOUL" | "USER" | "HEARTBEAT", string>>;

/** What a person sets about an agent, as a version keeps it. Absent fields are the defaults. */
export interface AgentConfig {
  description?: string;
  tools?: string[];
  toolPermissions?: ToolPermissions;
  provider?: string;
  model?: string;
  fallbackProviders?: string[];
  scopeId?: string;
  standing?: StandingHashes;
}

export interface ConfigVersion {
  n: number;
  at: string;
  /** Who saved it: a person's name, or what made it when no person did. */
  by: string;
  config: AgentConfig;
  /** Set when this version is "go back to version n". */
  restoredFrom?: number;
}

/** A conversation or a task starting to run under a version: one switch point. */
export interface VersionUse {
  n: number;
  at: string;
  turn: string;
  conversation: string;
  task?: string;
}

type Line = ({ kind: "version" } & ConfigVersion) | ({ kind: "use" } & VersionUse);

/** The fields of a profile a version keeps, in a fixed shape so two equal settings compare equal. */
export function configOf(profile: {
  description?: string; tools?: readonly string[]; toolPermissions?: ToolPermissions; provider?: string; model?: string; fallbackProviders?: readonly string[]; scopeId?: string;
}, standing?: StandingHashes): AgentConfig {
  const sorted = <T>(record: Record<string, T> | undefined) => (record === undefined ? undefined : Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))));
  const permissions = profile.toolPermissions === undefined ? undefined : {
    ...(profile.toolPermissions.groups !== undefined ? { groups: sorted(profile.toolPermissions.groups) } : {}),
    ...(profile.toolPermissions.tools !== undefined ? { tools: sorted(profile.toolPermissions.tools) } : {}),
  };
  return {
    ...(profile.description !== undefined && profile.description !== "" ? { description: profile.description } : {}),
    ...(profile.tools !== undefined ? { tools: [...profile.tools].sort() } : {}),
    ...(permissions !== undefined && (permissions.groups !== undefined || permissions.tools !== undefined) ? { toolPermissions: permissions as ToolPermissions } : {}),
    ...(profile.provider !== undefined ? { provider: profile.provider } : {}),
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.fallbackProviders !== undefined && profile.fallbackProviders.length > 0 ? { fallbackProviders: [...profile.fallbackProviders] } : {}),
    ...(profile.scopeId !== undefined ? { scopeId: profile.scopeId } : {}),
    ...(standing !== undefined && Object.keys(standing).length > 0 ? { standing: sorted(standing) as StandingHashes } : {}),
  };
}

const same = (a: AgentConfig, b: AgentConfig) => JSON.stringify(a) === JSON.stringify(b);

/** One line of a diff, in words a person reads: what changed, from what, to what. */
export interface ConfigChange {
  field: string;
  before: string;
  after: string;
}

/**
 * What differs between two versions, field by field. Tools say which were added and taken away;
 * ask-before settings say each group and tool that moved; a standing file or the persona says its
 * hash changed, which is all a version knows of a file's content.
 */
export function configDiff(before: AgentConfig, after: AgentConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];
  const text = (value: string | undefined, fallback: string) => (value === undefined || value === "" ? fallback : value);
  if ((before.description ?? "") !== (after.description ?? "")) changes.push({ field: "persona", before: personaLine(before.description), after: personaLine(after.description) });
  if (JSON.stringify(before.tools) !== JSON.stringify(after.tools)) {
    if (before.tools === undefined || after.tools === undefined) changes.push({ field: "tools", before: before.tools === undefined ? "all" : `${before.tools.length} chosen`, after: after.tools === undefined ? "all" : `${after.tools.length} chosen` });
    else {
      const added = after.tools.filter(tool => !before.tools!.includes(tool));
      const removed = before.tools.filter(tool => !after.tools!.includes(tool));
      if (removed.length > 0) changes.push({ field: "tools off", before: "on", after: `off: ${removed.join(", ")}` });
      if (added.length > 0) changes.push({ field: "tools on", before: "off", after: `on: ${added.join(", ")}` });
    }
  }
  const permission = (value: ToolPermission | undefined) => (value === "ask" ? "ask me" : value === "allow" ? "allowed" : "default");
  const keys = <T>(a: Record<string, T> | undefined, b: Record<string, T> | undefined) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort().filter(key => a?.[key] !== b?.[key]);
  for (const group of keys(before.toolPermissions?.groups, after.toolPermissions?.groups)) {
    changes.push({ field: `${group} tools`, before: permission(before.toolPermissions?.groups?.[group as ToolGroup]), after: permission(after.toolPermissions?.groups?.[group as ToolGroup]) });
  }
  for (const tool of keys(before.toolPermissions?.tools, after.toolPermissions?.tools)) {
    changes.push({ field: tool, before: permission(before.toolPermissions?.tools?.[tool]), after: permission(after.toolPermissions?.tools?.[tool]) });
  }
  if (before.provider !== after.provider) changes.push({ field: "provider", before: text(before.provider, "installation default"), after: text(after.provider, "installation default") });
  if (before.model !== after.model) changes.push({ field: "model", before: text(before.model, "provider default"), after: text(after.model, "provider default") });
  if (JSON.stringify(before.fallbackProviders) !== JSON.stringify(after.fallbackProviders)) changes.push({ field: "fallbacks", before: before.fallbackProviders?.join(", ") ?? "installation's", after: after.fallbackProviders?.join(", ") ?? "installation's" });
  if (before.scopeId !== after.scopeId) changes.push({ field: "scope", before: text(before.scopeId, "none"), after: text(after.scopeId, "none") });
  for (const name of keys(before.standing, after.standing)) {
    const hash = (value: string | undefined) => (value === undefined ? "none" : value.slice(0, 8));
    changes.push({ field: `${name}.md`, before: hash(before.standing?.[name as keyof StandingHashes]), after: hash(after.standing?.[name as keyof StandingHashes]) });
  }
  return changes;
}

function personaLine(text: string | undefined): string {
  if (text === undefined || text === "") return "empty";
  const first = text.replace(/\s+/g, " ").trim();
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/** The fields of the profile a version restores, as `registry.update` takes them; `null` clears. Standing files are the box's and are not restored. */
export function changesFor(config: AgentConfig) {
  return {
    description: config.description ?? "",
    tools: config.tools ?? null,
    toolPermissions: config.toolPermissions ?? null,
    provider: config.provider ?? null,
    model: config.model ?? null,
    fallbackProviders: config.fallbackProviders ?? null,
    scopeId: config.scopeId ?? null,
  };
}

/** How many turns may be holding a version at once before the oldest hold is let go; a guard, never reached by turns that end. */
const HELD_LIMIT = 1000;

export class ConfigVersions {
  private readonly cache = new Map<string, { versions: ConfigVersion[]; uses: VersionUse[] }>();
  /** The configuration each running turn began under, by turn id, until it ends. */
  private readonly held = new Map<string, AgentConfig>();

  constructor(private readonly dirFor: (agentId: string) => string) {}

  private load(agentId: string): { versions: ConfigVersion[]; uses: VersionUse[] } {
    const cached = this.cache.get(agentId);
    if (cached !== undefined) return cached;
    const loaded = { versions: [] as ConfigVersion[], uses: [] as VersionUse[] };
    const path = join(this.dirFor(agentId), CONFIG_VERSIONS_FILENAME);
    if (existsSync(path)) {
      for (const raw of readFileSync(path, "utf8").split("\n")) {
        if (raw.trim() === "") continue;
        let line: Line;
        try { line = JSON.parse(raw) as Line; } catch { continue; } // a torn tail from a crash; the next append closes it
        const { kind, ...rest } = line;
        if (kind === "version") loaded.versions.push(rest as ConfigVersion);
        else if (kind === "use") loaded.uses.push(rest as VersionUse);
      }
    }
    this.cache.set(agentId, loaded);
    return loaded;
  }

  private append(agentId: string, line: Line): void {
    const dir = this.dirFor(agentId);
    if (!existsSync(dir)) return; // an agent removed while its turn ran keeps no history
    appendLine(join(dir, CONFIG_VERSIONS_FILENAME), JSON.stringify(line));
  }

  private add(agentId: string, config: AgentConfig, by: string, now: Date, restoredFrom?: number): ConfigVersion {
    const state = this.load(agentId);
    const version: ConfigVersion = { n: (state.versions.at(-1)?.n ?? 0) + 1, at: now.toISOString(), by, config, ...(restoredFrom !== undefined ? { restoredFrom } : {}) };
    state.versions.push(version);
    this.append(agentId, { kind: "version", ...version });
    return version;
  }

  list(agentId: string): readonly ConfigVersion[] {
    return this.load(agentId).versions;
  }

  get(agentId: string, n: number): ConfigVersion | undefined {
    return this.load(agentId).versions.find(version => version.n === n);
  }

  latest(agentId: string): ConfigVersion | undefined {
    return this.load(agentId).versions.at(-1);
  }

  /**
   * A save in Configure: the profile as it now is becomes a version, when it differs from the last.
   * `before` is the profile as it was before the save; an agent with no history yet gets that as
   * version 1, so the first save has something to be compared with. Standing hashes carry forward
   * from the last version: a save does not read the box.
   */
  saved(agentId: string, after: Parameters<typeof configOf>[0], by: string, options: { before?: Parameters<typeof configOf>[0]; restoredFrom?: number; now?: Date } = {}): ConfigVersion {
    const now = options.now ?? new Date();
    if (this.latest(agentId) === undefined && options.before !== undefined) this.add(agentId, configOf(options.before), "before version history", now);
    const standing = this.latest(agentId)?.config.standing;
    const config = configOf(after, standing);
    const last = this.latest(agentId);
    if (last !== undefined && same(last.config, config) && options.restoredFrom === undefined) return last;
    return this.add(agentId, config, by, now, options.restoredFrom);
  }

  /**
   * A turn beginning: the version of the profile it was handed, which it holds until `release`.
   * A version equal to it is reused — the newest such, so a save that landed while this turn was
   * being set up does not mint a copy of the version it replaced; only a profile changed outside
   * Configure (the CLI, a template install, a standing file edited in the box) makes a new one here.
   * Records a switch point when this conversation or task was running under another version.
   */
  beginTurn(input: { agentId: string; profile: Parameters<typeof configOf>[0]; turnId: string; conversation: string; task?: string | undefined; standing?: StandingHashes; now?: Date }): ConfigVersion {
    const now = input.now ?? new Date();
    const state = this.load(input.agentId);
    const standing = input.standing !== undefined && Object.keys(input.standing).length > 0 ? input.standing : state.versions.at(-1)?.config.standing;
    const config = configOf(input.profile, standing);
    const last = state.versions.at(-1);
    const why = last === undefined ? "as first seen" : same(configOf(input.profile, last.config.standing), last.config) ? "standing files changed in the box" : "changed outside Configure";
    const version = [...state.versions].reverse().find(entry => same(entry.config, config)) ?? this.add(input.agentId, config, why, now);
    const lastHere = state.uses.findLast(use => use.conversation === input.conversation);
    const lastForTask = input.task === undefined ? undefined : state.uses.findLast(use => use.task === input.task);
    if (lastHere?.n !== version.n || (input.task !== undefined && lastForTask?.n !== version.n)) {
      const use: VersionUse = { n: version.n, at: now.toISOString(), turn: input.turnId, conversation: input.conversation, ...(input.task !== undefined ? { task: input.task } : {}) };
      state.uses.push(use);
      this.append(input.agentId, { kind: "use", ...use });
    }
    this.held.set(input.turnId, version.config);
    if (this.held.size > HELD_LIMIT) this.held.delete(this.held.keys().next().value!);
    return version;
  }

  /** The configuration a running turn began under; undefined for a turn that is not running (or never began here). */
  heldBy(turnId: string): AgentConfig | undefined {
    return this.held.get(turnId);
  }

  release(turnId: string): void {
    this.held.delete(turnId);
  }

  /** Where a conversation started running under each version, in order. */
  usesIn(agentId: string, conversation: string): VersionUse[] {
    return switches(this.load(agentId).uses.filter(use => use.conversation === conversation));
  }

  /** Where a task started running under each version, in order. */
  usesFor(agentId: string, task: string): VersionUse[] {
    return switches(this.load(agentId).uses.filter(use => use.task === task));
  }
}

/** A use line is written when either its conversation or its task switched; read for one of them, a line where that one did not switch is dropped. */
const switches = (uses: VersionUse[]) => uses.filter((use, index) => index === 0 || uses[index - 1]!.n !== use.n);

/**
 * The ask-before settings in effect for one call: the running turn's version when the call belongs
 * to a turn that began under one, else the profile as it is now. The one reader the policy gate is
 * given, by the orchestrator and by the scenario harness alike.
 */
export function permissionsInEffect(
  registry: { configVersions: ConfigVersions; tryGet: (agentId: string) => { profile: { toolPermissions?: ToolPermissions } } | undefined },
  agentId: string,
  turnId: string | undefined
): ToolPermissions | undefined {
  const held = turnId === undefined ? undefined : registry.configVersions.heldBy(turnId);
  return held !== undefined ? held.toolPermissions : registry.tryGet(agentId)?.profile.toolPermissions;
}

/** One switch point as the task detail and the conversation header draw it: which agent, which version, from when, saved by whom. */
export interface VersionSwitch {
  agentId: string;
  agentName: string;
  n: number;
  /** When the task or conversation started running under it. */
  from: string;
  turn: string;
  /** When the version itself was made, and by whom. */
  savedAt: string;
  by: string;
  restoredFrom?: number;
}

function switchOf(registry: { configVersions: ConfigVersions }, agent: { id: string; name: string }, use: VersionUse): VersionSwitch {
  const version = registry.configVersions.get(agent.id, use.n);
  return {
    agentId: agent.id, agentName: agent.name, n: use.n, from: use.at, turn: use.turn,
    savedAt: version?.at ?? use.at, by: version?.by ?? "", ...(version?.restoredFrom !== undefined ? { restoredFrom: version.restoredFrom } : {}),
  };
}

/**
 * Every version a task ran under, in the order it switched to them — over every agent that worked
 * on it, since a task can change hands. The last one is the version in effect; more than one is a
 * task that spans a change, and each entry is where it took effect.
 */
export function switchesForTask(registry: { configVersions: ConfigVersions; list: () => readonly { id: string; profile: { name: string } }[] }, taskId: string): VersionSwitch[] {
  return registry.list()
    .flatMap(record => registry.configVersions.usesFor(record.id, taskId).map(use => switchOf(registry, { id: record.id, name: record.profile.name }, use)))
    .sort((a, b) => a.from.localeCompare(b.from));
}

/** The same for one agent's conversation: what the header says is in effect, and where it changed. */
export function switchesInConversation(registry: { configVersions: ConfigVersions }, agent: { id: string; name: string }, conversation: string): VersionSwitch[] {
  return registry.configVersions.usesIn(agent.id, conversation).map(use => switchOf(registry, agent, use));
}
