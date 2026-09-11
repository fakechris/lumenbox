/**
 * A Bundle: a named set of capabilities, attached to a *place* — the installation or a
 * box — never to an agent or a chat (docs/22 §8, docs/50 G).
 *
 * The Scope (`scopes.ts`) was the first attempt at this and was attached to the wrong
 * subjects: an agent, a chat. Two agents in one box could then differ in what they could
 * reach, which §0 of the domain model forbids, and a door could carry authority, which
 * §2 forbids. A bundle fixes the subject. What it carries is what Claude Tag's Access
 * Bundle carries — skills, MCP servers, connectors, secrets, egress hosts, repositories,
 * instructions — and where it lives is the installation's default list and each box's
 * own list. A box's effective capability is the union of both; an agent's offered tool
 * set is that union narrowed by its own `tools`, which is labour shaping and stays on the
 * worker.
 *
 * What is enforced in this change, honestly:
 *
 *   - **skills** — enforced. When any bundle a box carries lists skills, the box's agents
 *     are offered only the union of those names; when none does, every skill (as before).
 *   - **secretIds** — enforced. `RunOnHost` resolves a secret the box's bundles grant.
 *   - **instructions** — stored; concatenated into the prompt by INV-428.
 *   - **egressHosts, repositories, mcpServers, connectors** — stored and unioned; the
 *     relay (INV-423), the box (INV-438) and the MCP manager (INV-439) read them next.
 *
 * ~/.agentbox/bundles.json, 0600, because it names secrets. Reload-on-edit like scopes.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";
import type { Scope } from "./scopes.ts";

export interface Repository {
  path: string;
  mode: "ro" | "rw";
}

export interface Bundle {
  id: string;
  name: string;
  /** Skill slugs. Absent contributes nothing to the box's allowlist (see `forBox`). */
  skills?: string[];
  /** Names of `config.json` mcpServers entries. Stored; read by INV-439. */
  mcpServers?: string[];
  /** Connector slugs (docs/37). Stored; read by INV-439. */
  connectors?: string[];
  /** Vault secret ids the box's agents may resolve. */
  secretIds: string[];
  /** Egress hosts. Stored; enforced per box by INV-423. */
  egressHosts?: string[];
  /** Directories, with mode. Stored; enforced by the desktop-less host box of INV-438. */
  repositories?: Repository[];
  /** Prompt text for every agent in a box carrying this bundle. Concatenated by INV-428. */
  instructions?: string;
}

/** The file: the bundles, and where they are attached. */
export interface BundlesFile {
  bundles: Bundle[];
  /** Installation-wide: every box carries these. */
  defaults?: string[];
  /** Per box, keyed by box name (what `box attach <name>` and people use) or box id. */
  boxes?: Record<string, string[]>;
}

/** A box's capability, after the union. Sets are unioned; absent skills means no narrowing. */
export interface EffectiveBundle {
  /** Which bundles made this, in attachment order (defaults first). */
  names: string[];
  skills: string[] | undefined;
  mcpServers: string[];
  connectors: string[];
  secretIds: string[];
  egressHosts: string[];
  repositories: Repository[];
  instructions: string[];
}

/** Two bundles on one box that disagree. Loud at union time, never a silent last-wins. */
export class BundleConflictError extends Error {}

export function bundlesPath(): string {
  return process.env.AGENTBOX_BUNDLES ?? join(agentboxHome(), "bundles.json");
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;

function normalizeBundle(raw: Partial<Bundle> & { id: string; name: string }): Bundle {
  const skills = strings(raw.skills);
  const mcpServers = strings(raw.mcpServers);
  const connectors = strings(raw.connectors);
  const egressHosts = strings(raw.egressHosts);
  const repositories = Array.isArray(raw.repositories)
    ? raw.repositories
        .filter((entry): entry is Repository => typeof entry?.path === "string" && entry.path !== "")
        .map(entry => ({ path: entry.path, mode: entry.mode === "ro" ? "ro" : "rw" }) as Repository)
    : undefined;
  return {
    id: raw.id,
    name: raw.name,
    ...(skills !== undefined ? { skills } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(connectors !== undefined ? { connectors } : {}),
    secretIds: strings(raw.secretIds) ?? [],
    ...(egressHosts !== undefined ? { egressHosts } : {}),
    ...(repositories !== undefined && repositories.length > 0 ? { repositories } : {}),
    ...(typeof raw.instructions === "string" && raw.instructions.trim() !== ""
      ? { instructions: raw.instructions }
      : {}),
  };
}

/**
 * The union of a list of bundles, in order.
 *
 * Union, not override: a box carrying "vendor" and "ops" may reach what either grants.
 * The one thing two bundles can *disagree* on is a repository's mode, and that is an
 * error rather than the wider or the narrower of the two — whoever attached both has to
 * say which they meant.
 */
export function unionBundles(bundles: readonly Bundle[]): EffectiveBundle {
  const skills = new Set<string>();
  let anySkills = false;
  const mcpServers = new Set<string>();
  const connectors = new Set<string>();
  const secretIds = new Set<string>();
  const egressHosts = new Set<string>();
  const repositories = new Map<string, Repository>();
  const instructions: string[] = [];
  for (const bundle of bundles) {
    if (bundle.skills !== undefined) {
      anySkills = true;
      for (const slug of bundle.skills) skills.add(slug);
    }
    for (const name of bundle.mcpServers ?? []) mcpServers.add(name);
    for (const slug of bundle.connectors ?? []) connectors.add(slug);
    for (const id of bundle.secretIds) secretIds.add(id);
    for (const host of bundle.egressHosts ?? []) egressHosts.add(host);
    for (const repo of bundle.repositories ?? []) {
      const seen = repositories.get(repo.path);
      if (seen !== undefined && seen.mode !== repo.mode) {
        throw new BundleConflictError(
          `Bundle ${JSON.stringify(bundle.name)} wants ${repo.path} ${repo.mode} but another bundle on this box has it ${seen.mode}. Attach one, or make them agree.`
        );
      }
      repositories.set(repo.path, repo);
    }
    if (bundle.instructions !== undefined) instructions.push(bundle.instructions);
  }
  return {
    names: bundles.map(bundle => bundle.name),
    skills: anySkills ? [...skills] : undefined,
    mcpServers: [...mcpServers],
    connectors: [...connectors],
    secretIds: [...secretIds],
    egressHosts: [...egressHosts],
    repositories: [...repositories.values()],
    instructions,
  };
}

/** The skills a box's agents are offered: all of them, or the bundles' union. */
export function narrowSkills<T extends { slug: string }>(
  skills: readonly T[],
  effective: EffectiveBundle | undefined
): T[] {
  if (effective === undefined || effective.skills === undefined) return [...skills];
  const allowed = new Set(effective.skills);
  return skills.filter(skill => allowed.has(skill.slug));
}

export class BundleStore {
  private bundles = new Map<string, Bundle>();
  private defaults: string[] = [];
  private boxes = new Map<string, string[]>();

  constructor(private readonly path: string = bundlesPath()) {
    this.reload();
  }

  reload(): void {
    this.bundles.clear();
    this.defaults = [];
    this.boxes.clear();
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<BundlesFile>;
      for (const raw of parsed.bundles ?? []) {
        if (typeof raw?.id !== "string" || typeof raw?.name !== "string") continue;
        this.bundles.set(raw.id, normalizeBundle(raw as Partial<Bundle> & { id: string; name: string }));
      }
      this.defaults = strings(parsed.defaults) ?? [];
      for (const [box, ids] of Object.entries(parsed.boxes ?? {})) {
        const list = strings(ids);
        if (list !== undefined) this.boxes.set(box, list);
      }
    } catch {
      // A broken file is no bundles, not a broken server: every box then has everything,
      // which is the pre-bundle behaviour and is stated in the header.
    }
  }

  list(): Bundle[] {
    return [...this.bundles.values()].map(bundle => ({ ...bundle }));
  }

  get(id: string | undefined): Bundle | undefined {
    if (id === undefined) return undefined;
    const bundle = this.bundles.get(id);
    return bundle === undefined ? undefined : { ...bundle };
  }

  attachments(): { defaults: string[]; boxes: Record<string, string[]> } {
    return { defaults: [...this.defaults], boxes: Object.fromEntries(this.boxes) };
  }

  /**
   * The bundles a box carries: the installation's defaults, then its own, by name or id.
   * An id that names no bundle is skipped and reported by `dangling`, not thrown here —
   * a typo in the file must not take every agent's tools away.
   */
  attachedTo(box: { id: string; name: string }): Bundle[] {
    const ids = [...this.defaults, ...(this.boxes.get(box.name) ?? []), ...(this.boxes.get(box.id) ?? [])];
    const seen = new Set<string>();
    const out: Bundle[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const bundle = this.bundles.get(id);
      if (bundle !== undefined) out.push(bundle);
    }
    return out;
  }

  /** Attachment ids that name no bundle, for the operator to read. */
  dangling(): string[] {
    const all = [...this.defaults, ...[...this.boxes.values()].flat()];
    return [...new Set(all.filter(id => !this.bundles.has(id)))];
  }

  /** A box's effective capability, or undefined when it carries no bundle at all. */
  forBox(box: { id: string; name: string }): EffectiveBundle | undefined {
    const attached = this.attachedTo(box);
    return attached.length === 0 ? undefined : unionBundles(attached);
  }

  grantsSecret(box: { id: string; name: string } | undefined, secretId: string): boolean {
    if (box === undefined) return false;
    return this.attachedTo(box).some(bundle => bundle.secretIds.includes(secretId));
  }

  save(file: BundlesFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
    this.reload();
  }
}

/**
 * The migration of docs/22 §8.4, as a plan the operator reads before it is written.
 *
 * Every scope becomes a bundle of the same id. `secretIds`, `egressHosts` and
 * `filesRoot` (as an rw repository) travel. `tools` do not — they were labour shaping
 * and stay on the agent; the report says which agents to set. A scope bound to chats
 * is reported and its chat bindings dropped: doors carry no authority. A scope an agent
 * was in attaches to that agent's box; an agent whose box cannot be named is reported
 * and nothing is attached for it, which fails closed.
 */
export function planMigration(
  scopes: readonly Scope[],
  agents: readonly { id: string; name: string; scopeId?: string; box?: { id: string; name: string } }[],
  existing: BundlesFile = { bundles: [] }
): { file: BundlesFile; report: string[] } {
  const report: string[] = [];
  const bundles = new Map(existing.bundles.map(bundle => [bundle.id, bundle]));
  const boxes = new Map(Object.entries(existing.boxes ?? {}).map(([box, ids]) => [box, [...ids]]));
  for (const scope of scopes) {
    if (bundles.has(scope.id)) {
      report.push(`scope ${scope.id}: a bundle with this id already exists; left as is`);
      continue;
    }
    bundles.set(
      scope.id,
      normalizeBundle({
        id: scope.id,
        name: scope.name,
        secretIds: scope.secretIds,
        ...(scope.egressHosts !== undefined ? { egressHosts: scope.egressHosts } : {}),
        ...(scope.filesRoot !== undefined ? { repositories: [{ path: scope.filesRoot, mode: "rw" }] } : {}),
      })
    );
    report.push(`scope ${scope.id} → bundle ${scope.id} (${scope.secretIds.length} secret(s))`);
    if (scope.tools !== undefined) {
      report.push(`  tools [${scope.tools.join(", ")}] stay on the agent, not the bundle — set them on each agent that was in this scope`);
    }
    if (scope.chats !== undefined && scope.chats.length > 0) {
      report.push(`  chat bindings dropped (doors carry no authority): ${scope.chats.join(", ")}`);
    }
  }
  for (const agent of agents) {
    if (agent.scopeId === undefined) continue;
    if (!bundles.has(agent.scopeId)) {
      report.push(`agent ${agent.name}: scope ${agent.scopeId} does not exist; nothing attached`);
      continue;
    }
    if (agent.box === undefined) {
      report.push(`agent ${agent.name}: box unknown; ${agent.scopeId} NOT attached (fails closed — attach it by hand)`);
      continue;
    }
    const list = boxes.get(agent.box.name) ?? [];
    if (!list.includes(agent.scopeId)) {
      list.push(agent.scopeId);
      boxes.set(agent.box.name, list);
      report.push(`box ${agent.box.name} ← ${agent.scopeId} (because ${agent.name} was in it)`);
    }
  }
  return {
    file: {
      bundles: [...bundles.values()],
      ...(existing.defaults !== undefined ? { defaults: existing.defaults } : {}),
      ...(boxes.size > 0 ? { boxes: Object.fromEntries(boxes) } : {}),
    },
    report,
  };
}
