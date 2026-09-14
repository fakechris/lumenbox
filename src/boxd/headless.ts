/**
 * A box without a desktop, and the directories it may touch (INV-438, docs/50 G5).
 *
 * The product decision of 2026-09-10: the person's own Mac is not a "project" but an
 * Environment — a box with a shell and files and no screen. boxd runs there natively with
 * BOXD_HEADLESS=1: nothing that needs X is started, and every route that would need it
 * answers 409 with a sentence instead of a stack trace. The "local project" is not a new
 * thing either: it is Claude Tag's Repositories, a bundle entry `{path, mode}` that the
 * host writes into BOXD_REPOSITORIES at start and this file enforces on every file read,
 * write and listing. Outside the roots is refused, and said.
 *
 * Pure: the environment is parsed once, the checks take a path and a mode.
 */

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

export interface Repository {
  path: string;
  mode: "ro" | "rw";
}

/** `BOXD_REPOSITORIES` is JSON: `[{"path": "/Users/me/proj", "mode": "rw"}, …]`. */
export function parseRepositories(raw: string | undefined): Repository[] {
  if (raw === undefined || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is { path: string; mode?: string } => typeof entry?.path === "string" && entry.path !== "")
      .map(entry => ({ path: resolve(entry.path), mode: entry.mode === "ro" ? "ro" : "rw" }) as Repository);
  } catch {
    return [];
  }
}

/**
 * The roots a box may touch. Empty means unrestricted — the Docker box, whose whole
 * filesystem is the agent's. `realpath` on both sides, because a symlink inside a root
 * that points out of it is the obvious way past a prefix check.
 */
export class Roots {
  constructor(private readonly repositories: readonly Repository[]) {}

  get restricted(): boolean {
    return this.repositories.length > 0;
  }

  list(): Repository[] {
    return this.repositories.map(entry => ({ ...entry }));
  }

  /** Why a path may not be used this way, or undefined when it may. */
  refusal(path: string, mode: "ro" | "rw"): string | undefined {
    if (!this.restricted) return undefined;
    const target = realOrResolved(path);
    for (const root of this.repositories) {
      const base = realOrResolved(root.path);
      const inside = target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
      if (!inside) continue;
      if (mode === "rw" && root.mode === "ro") {
        return `${path} is inside ${root.path}, which this box may only read. Writing there needs the repository granted rw in the box's bundle.`;
      }
      return undefined;
    }
    return `${path} is outside the directories this box may touch (${this.repositories.map(r => `${r.path} ${r.mode}`).join(", ")}). Ask the person to add it to the box's bundle.`;
  }
}

function realOrResolved(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    // A path that does not exist yet (a file about to be written): judge it by its
    // nearest existing ancestor, so a symlinked parent still cannot escape.
    let probe = absolute;
    let rest = "";
    for (let i = 0; i < 64; i++) {
      const parent = resolve(probe, "..");
      if (parent === probe) return absolute;
      rest = `${sep}${probe.slice(parent.length + 1)}${rest}`;
      probe = parent;
      try {
        return `${realpathSync(probe)}${rest}`;
      } catch {
        // Keep climbing.
      }
    }
    return absolute;
  }
}

/** The routes a desktop-less box cannot serve, and what it says instead. */
export const DESKTOP_ROUTE = /^(GET|POST) \/(computer|browser|displays|record|recordings|clipboard|teach|xwatchdog)(\/|$)/;

export function headlessRefusal(route: string): string | undefined {
  if (!DESKTOP_ROUTE.test(route)) return undefined;
  return "This box has no desktop: it is the person's own machine, running headless. Use bash and the file tools; there is no screen, no browser and no recording here.";
}
