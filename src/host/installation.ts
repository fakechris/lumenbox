/**
 * Owner and Admin: what kind of installation this is (INV-1685, docs/22 §1a).
 *
 * The desktop app on one computer has one person, the **Owner** (机主), and never another: a
 * personal installation is not converted into an organisation (INV-1689, route B). An
 * organisation is its own installation — a server deployment — with **Admins** (管理员). Both hold the role `admin` — the permission is the same — and which word a person
 * reads is decided by one field in the roster file, `installation.mode`, not by a fourth role.
 * One field per installation is what makes "Owner or Admin, never both" a property of the data:
 * there is no state in which one person is the Owner while another is an Admin.
 *
 * - The Owner is created only by `ensureOwner`: under the roster lock, only for the desktop app
 *   (the Electron shell passes `--desktop`), only on an empty roster whose bootstrap was never
 *   redeemed or closed, and it closes bootstrap in the same atomic write. A server start never
 *   creates one; it keeps the bootstrap code that produces the first Admin.
 * - While the mode is `single-machine`, the roster holds the Owner and nobody else
 *   (`guardRoster`, called by every roster save). Adding a person is refused with
 *   `PersonalInstallationOnly`, whose sentence says to join or create an organisation; nothing
 *   turns the mode into `organisation`.
 * - An installation converted before INV-1689 (`installation.conversion` present) is an
 *   organisation and stays one; `openRoster` says so in one `upgrade:` line.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { tr } from "../i18n/messages.ts";
import { withRosterLock } from "./roster-lock.ts";

export type InstallationMode = "single-machine" | "organisation";

export interface Installation {
  mode: InstallationMode;
  /** The Owner's principal id; kept on an installation converted before INV-1689, whose Owner became its first Admin. */
  ownerId?: string;
  createdAt?: number;
  /** The audit record of a conversion made before INV-1689 (when, and who confirmed it). Read, never written. */
  conversion?: { at: number; by: string; ownerId: string };
  /** A personal installation made by folding an older roster's people — all one person — into the Owner (INV-1698, self-merge.ts): when, and the ids folded in. */
  merged?: { at: number; from: string[] };
}

/** The Owner's principal id. Fixed, so an MCP token or a watchdog issued to the Owner keeps its owner across renames. */
export const OWNER_ID = "local:owner";

/** The sentence a refused add-person reads, in the bundle (zh and en). */
export const PERSONAL_ONLY_KEY = "ui.installation.personal-only";

/** A roster write, or an invite, that would add a second person to a single-machine installation. The web answers 409 with the sentence in the reader's language and the manual page. */
export class PersonalInstallationOnly extends Error {
  readonly needs = "organisation";
  readonly key = PERSONAL_ONLY_KEY;
  constructor() {
    super(tr(PERSONAL_ONLY_KEY, "en"));
  }
}

/** What a roster file says the installation is. No field, or one this code cannot read, is an organisation: the shape every installation had before INV-1685. */
export function installationOf(file: unknown): Installation {
  const raw = (file as { installation?: Partial<Installation> } | null)?.installation;
  if (raw === null || typeof raw !== "object") return { mode: "organisation" };
  if (raw.mode === "single-machine" && typeof raw.ownerId === "string" && raw.ownerId !== "") {
    return { mode: "single-machine", ownerId: raw.ownerId, ...(typeof raw.createdAt === "number" ? { createdAt: raw.createdAt } : {}), ...(raw.merged !== undefined && typeof raw.merged === "object" && raw.merged !== null ? { merged: raw.merged } : {}) };
  }
  return { ...(raw as Installation), mode: "organisation" };
}

/** Refuses a roster a single-machine installation cannot hold: anyone besides the Owner, or no Owner who is admin. */
export function guardRoster(installation: Installation, people: readonly { id: string; role: string }[]): void {
  if (installation.mode !== "single-machine") return;
  if (people.some(person => person.id !== installation.ownerId)) throw new PersonalInstallationOnly();
  const owner = people.find(person => person.id === installation.ownerId);
  if (owner === undefined || owner.role !== "admin") throw new Error("The Owner cannot be removed or given another role on a single-machine installation. Rename them instead.");
}

/** The word a person reads for someone's role: `owner` for the Owner of a single-machine installation, otherwise the role itself. */
export function roleLabel(installation: Installation, principalId: string | undefined, role: string): string {
  return installation.mode === "single-machine" && principalId === installation.ownerId ? "owner" : role;
}

/** The name the Owner starts with: the computer's user name, else "Owner". It is renamed in Settings → Team → People. */
export function defaultOwnerName(): string {
  try { return userInfo().username.trim().slice(0, 60) || "Owner"; } catch { return "Owner"; }
}

export type OwnerOutcome = "server" | "not-empty" | "closed" | "created" | "created-on-upgrade";

interface RosterFile { principals?: unknown[]; bootstrap?: { hash?: unknown; disabled?: unknown; redeemedAt?: unknown }; installation?: unknown }

function readRoster(path: string): RosterFile {
  if (!existsSync(path)) return { principals: [] };
  const value = JSON.parse(readFileSync(path, "utf8")) as RosterFile;
  if (!value || typeof value !== "object" || !Array.isArray(value.principals)) throw new Error("Repair the roster before creating the Owner");
  if (value.bootstrap !== undefined && (value.bootstrap === null || typeof value.bootstrap !== "object")) throw new Error("Repair bootstrap state");
  return value;
}

function writeRoster(path: string, value: RosterFile): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

/**
 * Creates the Owner when, and only when, this is the desktop app's first start on this roster:
 * desktop, no principal, and a bootstrap that was neither redeemed nor closed. A bootstrap code
 * an earlier version armed (an empty-roster desktop installation upgraded) is closed and its file
 * deleted in the same step — that is the `created-on-upgrade` outcome, which the server logs.
 * Serialised with bootstrap redemption and every roster save by the roster lock, so two
 * concurrent starts create one Owner and a redemption and an Owner never both happen.
 */
export function ensureOwner(path: string, codePath: string, options: { desktop: boolean; name?: string; now?: number }): OwnerOutcome {
  if (!options.desktop) return "server";
  return withRosterLock(path, () => {
    const roster = readRoster(path);
    if ((roster.principals ?? []).length > 0) return "not-empty";
    const bootstrap = roster.bootstrap;
    if (bootstrap?.redeemedAt !== undefined || bootstrap?.disabled === true || installationOf(roster).conversion !== undefined) return "closed";
    const now = options.now ?? Date.now();
    const name = (options.name ?? defaultOwnerName()).trim().slice(0, 60) || "Owner";
    writeRoster(path, {
      ...roster,
      installation: { mode: "single-machine", ownerId: OWNER_ID, createdAt: now },
      bootstrap: { disabled: true },
      principals: [{ id: OWNER_ID, name, role: "admin", identities: [], anchors: [] }],
    });
    // After the roster says closed: a crash between the two leaves a dead code, never a live one.
    rmSync(codePath, { force: true });
    return typeof bootstrap?.hash === "string" ? "created-on-upgrade" : "created";
  });
}

/**
 * The roster's first-start step, in order: the Owner when this is the desktop app's first start
 * (or its first start after an upgrade), then the bootstrap code a server keeps for its first
 * Admin — which, once the Owner exists, finds a non-empty roster and arms nothing.
 */
export function openRoster(deps: { desktop: boolean; path: string; codePath: string; bootstrap: { ensure: () => boolean }; reload: () => void; log: (line: string) => void }): void {
  try {
    const outcome = ensureOwner(deps.path, deps.codePath, { desktop: deps.desktop });
    if (existsSync(deps.path) && installationOf(JSON.parse(readFileSync(deps.path, "utf8"))).conversion !== undefined) {
      deps.log("upgrade: this installation was converted from one Owner to an organisation before INV-1689; it stays an organisation, unchanged, and a personal installation is no longer converted.");
    }
    if (outcome === "created" || outcome === "created-on-upgrade") {
      deps.reload();
      deps.log(outcome === "created"
        ? "Owner created for this computer (desktop app, first start, INV-1685); first-admin bootstrap closed."
        : "upgrade: this desktop installation had nobody on its roster, so its Owner was created and the first-admin bootstrap code it had armed was closed (INV-1685).");
    }
    if (deps.bootstrap.ensure()) deps.log("First-admin bootstrap is available at /bootstrap; retrieve the code from the local bootstrap-code file (24h, one use).");
  } catch { deps.log("First-admin bootstrap disabled: repair the local roster/bootstrap state."); }
}
