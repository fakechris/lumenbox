/**
 * What a person chose about how the UI is arranged, kept with the person (INV-121).
 *
 * The sidebar's teams / A–Z toggle and its team filter used to live in localStorage, which is a
 * fact about a browser: a second browser on the same machine, or the same person on another
 * machine, started at the default and the choice had to be made again. These are habits, not
 * session state, so they live here, keyed by the identity the request carries — and by a fixed
 * key for the operator who holds the installation's own credential and has no identity.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PersonPreferences {
  /** How the sidebar is arranged. */
  groupBy?: "teams" | "az";
  /** The one team shown, or absent for all. */
  team?: string;
}

/** The key for the operator with no identity of their own. */
export const OPERATOR_KEY = "operator";

export class PreferenceStore {
  private rows: Record<string, PersonPreferences> = {};

  constructor(private readonly path: string) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { people?: Record<string, PersonPreferences> };
      this.rows = parsed.people !== null && typeof parsed.people === "object" ? parsed.people : {};
    } catch {
      // No file yet, or an unreadable one: everyone starts at the defaults.
    }
  }

  get(identity: string | undefined): PersonPreferences {
    return { ...(this.rows[identity ?? OPERATOR_KEY] ?? {}) };
  }

  /** Applies the fields given; `null` clears one. Unknown fields and wrong types are dropped. */
  set(identity: string | undefined, patch: Record<string, unknown>): PersonPreferences {
    const key = identity ?? OPERATOR_KEY;
    const next: PersonPreferences = { ...(this.rows[key] ?? {}) };
    if ("groupBy" in patch) {
      if (patch.groupBy === "teams" || patch.groupBy === "az") next.groupBy = patch.groupBy;
      else if (patch.groupBy === null) delete next.groupBy;
    }
    if ("team" in patch) {
      if (typeof patch.team === "string" && patch.team.trim() !== "") next.team = patch.team.trim().slice(0, 24);
      else if (patch.team === null || patch.team === "") delete next.team;
    }
    this.rows[key] = next;
    this.save();
    return { ...next };
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ people: this.rows }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
