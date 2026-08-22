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

interface PrincipalsFile {
  principals: Principal[];
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
  private principals: Principal[] = [];
  private byIdentity = new Map<string, Principal>();

  constructor(private readonly path: string = principalsPath()) {
    this.reload();
  }

  reload(): void {
    this.principals = [];
    this.byIdentity.clear();
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as PrincipalsFile;
      for (const raw of parsed.principals ?? []) {
        if (typeof raw?.id !== "string" || typeof raw?.name !== "string") continue;
        const role: Role = raw.role === "admin" || raw.role === "driver" || raw.role === "viewer"
          ? raw.role
          : "viewer";
        const identities = Array.isArray(raw.identities)
          ? raw.identities.filter((entry): entry is string => typeof entry === "string")
          : [];
        const principal: Principal = { id: raw.id, name: raw.name, role, identities };
        this.principals.push(principal);
        for (const identity of identities) this.byIdentity.set(identity, principal);
      }
    } catch {
      // A broken file is an empty roster, not a broken server: everyone falls back to
      // the unknown-identity path, which is a viewer, which changes nothing.
    }
  }

  list(): Principal[] {
    return this.principals.map(principal => ({ ...principal, identities: [...principal.identities] }));
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

  /** Replaces the whole roster. The settings dialog's save. */
  save(principals: Principal[]): void {
    const cleaned = principals
      .filter(principal => principal.name.trim() !== "")
      .map(principal => ({
        id: principal.id,
        name: principal.name.trim(),
        role: principal.role,
        identities: [...new Set(principal.identities.map(identity => identity.trim()).filter(Boolean))],
      }));
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ principals: cleaned }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, this.path);
    chmodSync(this.path, 0o600);
    this.reload();
  }
}
