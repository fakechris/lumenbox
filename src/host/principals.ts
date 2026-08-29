/**
 * The people. A Principal is a person the system can name, place in a role, and
 * attribute work to — the human half of "who did this", which until now was a bare
 * token or an opaque `channel:id`.
 *
 * Deliberately small. This is not SSO or an org directory; it is the least that makes
 * the other objects honest: a name to show instead of `telegram:123`, a role that says
 * what a person may do (a viewer may read, a driver may command, an admin may change
 * settings), and a stable id to bill and audit against across every channel that
 * person speaks from.
 *
 * One person, many identities: the same human is `telegram:123` at home and
 * `feishu:ou_x` at work, and both should resolve to one Principal so their history and
 * their spend are one person's, not three strangers'. The file maps every identity to
 * its principal; an identity nobody has claimed is its own principal at the lowest
 * role, which is what keeps a fresh install working before anyone has configured a
 * thing.
 *
 * Two rules from docs/22 §4 live here, because this file is the access-control list:
 *
 * - **A link records the channel incarnation it was bound under.** A vendor subject
 *   from a replaced app must never be presumed equal to one from the old app, so a
 *   link from a retired incarnation stops resolving — mechanically, in `reload`,
 *   because the comparison happens there and not in anyone's memory of a config
 *   change. Legacy plain-string links are read as incarnation 1, the grandfathered
 *   one, and rewritten in the stamped form on the next save.
 * - **An identity belongs to at most one person.** Two principals claiming one link
 *   used to resolve last-write-wins, which is a coin toss over the access-control
 *   list. Now the first claim in roster order wins, later ones are dropped loudly, and
 *   `save` applies the same rule so the file never holds the conflict.
 *
 * ~/.agentbox/principals.json, 0600 like the config — it holds no secrets, but it is
 * the access-control list, and a world-readable one invites the question of who edited
 * it.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";

/**
 * What a person may do. Ordered: each role is a superset of the ones before it.
 *
 * - `viewer` reads — the transcript, the desktop, the files — and changes nothing.
 * - `driver` commands agents: sends prompts, answers approvals, takes over a desktop.
 * - `admin` also changes what the system is: settings, provider, the roster, and who
 *   else may do what.
 */
export type Role = "viewer" | "driver" | "admin";

const RANK: Record<Role, number> = { viewer: 0, driver: 1, admin: 2 };

export function roleAtLeast(have: Role | undefined, need: Role): boolean {
  if (have === undefined) return false;
  return RANK[have] >= RANK[need];
}

export interface Principal {
  id: string;
  name: string;
  role: Role;
  /** Every `channel:id` (or web token subject) this person speaks from. */
  identities: string[];
}

/** A link as stored: the identity plus the incarnation it was bound under. */
export interface IdentityLink {
  identity: string;
  incarnation: number;
}

interface StoredPrincipal {
  id: string;
  name: string;
  role: Role;
  links: IdentityLink[];
}

interface PrincipalsFile {
  principals: Array<{
    id: string;
    name: string;
    role: Role;
    /** Stamped links, or plain strings from before incarnations existed. */
    identities: Array<string | IdentityLink>;
  }>;
}

export function principalsPath(): string {
  return process.env.AGENTBOX_PRINCIPALS ?? join(agentboxHome(), "principals.json");
}

/**
 * The people, and the resolution from an identity to a person.
 *
 * Read on construction and re-read on demand, so an edit in the settings dialog or the
 * file itself takes effect without a restart — the same property the channel allow
 * list already has, and for the same reason.
 */
export class Principals {
  private stored: StoredPrincipal[] = [];
  private byIdentity = new Map<string, Principal>();
  private readonly incarnationOf: (identity: string) => number;
  private readonly warn: (line: string) => void;

  constructor(
    private readonly path: string = principalsPath(),
    options: {
      /**
       * The current incarnation of the channel an identity belongs to, by prefix.
       * Defaults to 1 for everything — correct while `ensureChannelRecords` pins
       * every incarnation to 1, and replaced by the real lookup where channels are
       * loaded. Web token subjects and unknown prefixes are 1 forever.
       */
      incarnationOf?: (identity: string) => number;
      warn?: (line: string) => void;
    } = {}
  ) {
    this.incarnationOf = options.incarnationOf ?? (() => 1);
    this.warn = options.warn ?? (line => console.error(`[principals] ${line}`));
    this.reload();
  }

  reload(): void {
    this.stored = [];
    this.byIdentity.clear();
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as PrincipalsFile;
      const claimed = new Set<string>();
      for (const raw of parsed.principals ?? []) {
        if (typeof raw?.id !== "string" || typeof raw?.name !== "string") continue;
        const role: Role = raw.role === "admin" || raw.role === "driver" || raw.role === "viewer"
          ? raw.role
          : "viewer";
        const links: IdentityLink[] = [];
        for (const entry of Array.isArray(raw.identities) ? raw.identities : []) {
          const link = asLink(entry);
          if (link === undefined) continue;
          if (claimed.has(link.identity)) {
            // One identity, one person. The first claim in roster order wins; a
            // silent coin toss over the access-control list is the bug this replaces.
            this.warn(`${link.identity} is claimed twice; keeping the first claim, dropping it from ${raw.name}`);
            continue;
          }
          claimed.add(link.identity);
          links.push(link);
        }
        const principal: StoredPrincipal = { id: raw.id, name: raw.name, role, links };
        this.stored.push(principal);
        for (const link of links) {
          // A link from a retired incarnation stays on the record (visible in the
          // roster, preserved across saves) but resolves nothing: the person behind
          // the old app's subject is not known to be the person behind the new one.
          if (link.incarnation !== this.incarnationOf(link.identity)) continue;
          this.byIdentity.set(link.identity, this.viewOf(principal));
        }
      }
    } catch {
      // A broken file is an empty roster, not a broken server: everyone falls back to
      // the unknown-identity path, which is a viewer, which changes nothing.
    }
  }

  private viewOf(principal: StoredPrincipal): Principal {
    return {
      id: principal.id,
      name: principal.name,
      role: principal.role,
      identities: principal.links.map(link => link.identity),
    };
  }

  list(): Principal[] {
    return this.stored.map(principal => this.viewOf(principal));
  }

  /**
   * The person behind an identity.
   *
   * An identity nobody has claimed resolves to an ad-hoc viewer named after the
   * identity — so the system works before anyone is configured, and an unconfigured
   * person can read but not command, which is the safe default.
   */
  resolve(identity: string): Principal {
    const known = this.byIdentity.get(identity);
    if (known !== undefined) return known;
    return { id: identity, name: identity, role: "viewer", identities: [identity] };
  }

  roleOf(identity: string): Role {
    return this.resolve(identity).role;
  }

  /** True when this identity is a configured person, not the fallback viewer. */
  isKnown(identity: string): boolean {
    return this.byIdentity.has(identity);
  }

  /**
   * Replaces the whole roster. The settings dialog's save.
   *
   * Incarnations are preserved for links a principal already held and stamped from
   * the current channel incarnation for new ones — a stale link cannot be
   * resurrected by a round-trip through the dialog, and a fresh link records the
   * world it was made in. The one-identity-one-person rule is applied here too, so
   * the file never stores the conflict `reload` would have to resolve.
   */
  save(principals: Principal[]): void {
    const previous = new Map<string, number>();
    for (const principal of this.stored) {
      for (const link of principal.links) {
        previous.set(`${principal.id} ${link.identity}`, link.incarnation);
      }
    }
    const claimed = new Set<string>();
    const cleaned: StoredPrincipal[] = principals
      .filter(principal => principal.name.trim() !== "")
      .map(principal => ({
        id: principal.id,
        name: principal.name.trim(),
        role: principal.role,
        links: [...new Set(principal.identities.map(identity => identity.trim()).filter(Boolean))]
          .filter(identity => {
            if (claimed.has(identity)) {
              this.warn(`${identity} is claimed twice; keeping the first claim, dropping it from ${principal.name}`);
              return false;
            }
            claimed.add(identity);
            return true;
          })
          .map(identity => ({
            identity,
            incarnation:
              previous.get(`${principal.id} ${identity}`) ?? this.incarnationOf(identity),
          })),
      }));
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    const file: PrincipalsFile = {
      principals: cleaned.map(principal => ({
        id: principal.id,
        name: principal.name,
        role: principal.role,
        identities: principal.links,
      })),
    };
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, this.path);
    chmodSync(this.path, 0o600);
    this.reload();
  }
}

function asLink(entry: string | IdentityLink | unknown): IdentityLink | undefined {
  if (typeof entry === "string") {
    const identity = entry.trim();
    // Plain strings predate incarnations; they were all bound under the
    // grandfathered incarnation, which is 1 by definition.
    return identity === "" ? undefined : { identity, incarnation: 1 };
  }
  if (typeof entry === "object" && entry !== null) {
    const link = entry as Partial<IdentityLink>;
    if (typeof link.identity === "string" && link.identity.trim() !== "") {
      return {
        identity: link.identity.trim(),
        incarnation: typeof link.incarnation === "number" ? link.incarnation : 1,
      };
    }
  }
  return undefined;
}
