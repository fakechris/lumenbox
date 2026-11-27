/**
 * Placing the organisation's skills in a box (INV-2222, docs/109 §6, docs/93 §1a).
 *
 * The library is on the server (`org-skills.ts`); a box holds a projection of it at
 * `orgSkillsDir(box)` — `<work>/.lumenbox/org-skills/<slug>/` — which the skill loader reads as a
 * second root. This module makes that directory say what the library says.
 *
 * - **When.** `syncDue()` is asked on a tick and after every change to the library. A box is due
 *   when it is connected and either the library is not at the revision last placed there, or the
 *   connection is not the one it was placed over (a box that was down, restarted, recreated or
 *   updated). A box that is down is not due; it becomes due when it connects.
 * - **How.** The directory is read and compared file by file with the library. A skill that
 *   differs, is missing, or is not the library's is removed whole and written again; a withdrawn
 *   one is removed; with no organisation skills the directory itself goes, and one that was never
 *   there is not made.
 * - **Read-only, exactly.** The box's daemon runs as the box's user, the same user an agent's
 *   shell runs as (`docker/box/entrypoint.sh`), and that user has `sudo` in the image. So the host
 *   cannot put a file there that the box's user is unable to change. What it does: after writing,
 *   every file and directory has its write bits removed (`chmod -R a-w`), so a write from inside
 *   the box is refused until somebody deliberately `chmod`s it back; an agent's `write_file` and
 *   `edit_file` are refused by the host before they reach the box (`skillWriteRefusal`); and
 *   whatever was changed anyway is written over at the next sync and reported as **drift** — the
 *   paths that were not what the host last placed.
 * - **What an Admin sees.** `status()` per box: `current`, `behind` (connected, not yet at the
 *   library's revision — a sync is on its way or failed, with the error), `offline` (not connected:
 *   synced when it comes back), and the drift found by the last sync.
 */

import type { ExecResult } from "../protocol/index.ts";
import { type BoxPlace, orgSkillsDir } from "./box-paths.ts";
import type { OrgSkill, OrgSkills, SkillFiles } from "./org-skills.ts";
import type { OrgSkillRoot } from "./skills.ts";

/** Just enough of the box client to place a directory of skills. */
export interface OrgSkillBox {
  listDir(path: string): Promise<{ entries: { name: string; type: string }[] }>;
  downloadFile(path: string): Promise<{ base64: string }>;
  writeFile(path: string, content: string): Promise<unknown>;
  exec(command: string, options?: { timeoutMs?: number; actor?: string }): Promise<Pick<ExecResult, "exit_code" | "stderr">>;
}

export interface PlaceResult {
  /** Skills written (new, updated, or put back). */
  written: string[];
  /** Skills removed (withdrawn, or never the library's). */
  removed: string[];
  /** Paths found in the box that were not what the library says and were not simply an older version: changed from inside. */
  drift: string[];
}

/** What the host last placed, kept in the directory so a restart of the host does not read an update as drift. */
const MANIFEST = ".placed.json";
const ACTOR = "host:org-skills";

/** A path as one shell word. A name found in the box is the box's to choose, so it is quoted whatever it holds. */
const quoted = (path: string): string => `'${path.replace(/'/g, "'\\''")}'`;

async function shell(box: OrgSkillBox, command: string): Promise<void> {
  const result = await box.exec(command, { timeoutMs: 60_000, actor: ACTOR });
  if (result.exit_code !== 0) throw new Error(`\`${command}\` failed in the box: ${result.stderr.trim().slice(0, 200) || `exit ${result.exit_code}`}`);
}

/** Every file under a directory in the box, relative path → text; a link or anything else that is not a file or a directory is named with no content. */
async function readTree(box: OrgSkillBox, dir: string, prefix = ""): Promise<Map<string, string | undefined>> {
  const files = new Map<string, string | undefined>();
  for (const entry of (await box.listDir(dir)).entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.type === "directory") for (const [name, text] of await readTree(box, path, `${prefix}${entry.name}/`)) files.set(name, text);
    else if (entry.type === "file") files.set(`${prefix}${entry.name}`, Buffer.from((await box.downloadFile(path)).base64, "base64").toString("utf8"));
    else files.set(`${prefix}${entry.name}`, undefined);
  }
  return files;
}

const same = (found: ReadonlyMap<string, string | undefined>, wanted: SkillFiles): boolean =>
  found.size === Object.keys(wanted).length && Object.entries(wanted).every(([path, text]) => found.get(path) === text);

/**
 * Makes `root` in the box hold exactly `skills`. Throws when the box refuses; nothing is
 * half-reported, and the next sync starts from what is there.
 */
export async function placeOrgSkills(box: OrgSkillBox, root: string, skills: readonly { slug: string; digest: string; files: SkillFiles }[]): Promise<PlaceResult> {
  const present = await box.listDir(root).then(listed => listed.entries, () => undefined);
  if (skills.length === 0) {
    // The last skill was withdrawn: the directory goes with it. One that was never there is not made.
    if (present === undefined) return { written: [], removed: [], drift: [] };
    await shell(box, `chmod -R u+w ${quoted(root)} 2>/dev/null; rm -rf ${quoted(root)}`);
    return { written: [], removed: present.filter(entry => entry.name !== MANIFEST).map(entry => entry.name), drift: [] };
  }
  const placed: Record<string, string> = await box.downloadFile(`${root}/${MANIFEST}`)
    .then(file => JSON.parse(Buffer.from(file.base64, "base64").toString("utf8")) as Record<string, string>, () => ({}));
  const wanted = new Map(skills.map(skill => [skill.slug, skill]));
  const written: string[] = [], removed: string[] = [], drift: string[] = [];
  for (const entry of present ?? []) {
    if (entry.name === MANIFEST) continue;
    const skill = wanted.get(entry.name);
    const found = entry.type === "directory" ? await readTree(box, `${root}/${entry.name}`) : new Map<string, string | undefined>();
    if (skill !== undefined && entry.type === "directory" && same(found, skill.files)) continue;
    // Not what the library says. An older version the host placed is an update or a withdrawal; anything else was changed in the box.
    const known = placed[entry.name];
    const files = skill?.files ?? {};
    if (known === undefined || entry.type !== "directory") drift.push(`${entry.name}${entry.type === "directory" ? "/" : ""} (not placed by the server)`);
    else if (known === skill?.digest) {
      for (const [path, text] of found) if (files[path] !== text) drift.push(`${entry.name}/${path}`);
      for (const path of Object.keys(files)) if (!found.has(path)) drift.push(`${entry.name}/${path} (removed)`);
    }
    (skill === undefined ? removed : written).push(entry.name);
  }
  for (const slug of wanted.keys()) if (!(present ?? []).some(entry => entry.name === slug)) written.push(slug);
  const changed = [...written, ...removed];
  if (changed.length > 0 || present === undefined) {
    await shell(box, `mkdir -p ${quoted(root)} && chmod -R u+w ${quoted(root)}${changed.map(slug => ` && rm -rf ${quoted(`${root}/${slug}`)}`).join("")}`);
    for (const slug of written) for (const [path, text] of Object.entries(wanted.get(slug)!.files)) await box.writeFile(`${root}/${slug}/${path}`, text);
    await box.writeFile(`${root}/${MANIFEST}`, `${JSON.stringify(Object.fromEntries(skills.map(skill => [skill.slug, skill.digest])))}\n`);
  }
  // Every sync, changed or not: a mode somebody opened is closed again.
  await shell(box, `chmod -R a-w ${quoted(root)}`);
  return { written, removed, drift };
}

export type BoxSyncState = "current" | "behind" | "offline";

export interface BoxSyncStatus {
  boxId: string;
  state: BoxSyncState;
  /** When the last sync that succeeded finished. */
  syncedAt?: string;
  /** Why the last attempt failed, when it did. */
  error?: string;
  /** What the last sync found changed from inside the box, and wrote over. */
  drift: string[];
}

export interface OrgSkillSyncDeps {
  /** What the organisation has now, with each skill's files; and the one number that changes when it does. */
  library: { list(): OrgSkill[]; filesOf(skill: OrgSkill): SkillFiles | undefined; revision(): string; acts(): readonly unknown[] };
  /** The installation's boxes, and each one's client when it is connected. */
  boxes: () => readonly { id: string; name: string; root: string }[];
  client: (boxId: string) => OrgSkillBox | undefined;
  /** Told after a sync changed a box, so its skills are read again before the next turn. */
  placed?: (boxId: string, result: PlaceResult) => void;
  log: (line: string) => void;
  now?: () => Date;
}

/** Keeps every connected box at the library's revision, and says where each stands. */
export class OrgSkillSync {
  private readonly last = new Map<string, { revision: string; over: OrgSkillBox; at: string; drift: string[] }>();
  private readonly errors = new Map<string, string>();
  private busy = false;
  private again = false;
  private pass: Promise<void> = Promise.resolve();

  constructor(private readonly deps: OrgSkillSyncDeps) {}

  /** Whether a connected box holds what the library says, over the connection it has now. */
  private current(boxId: string, client: OrgSkillBox, revision: string): boolean {
    const last = this.last.get(boxId);
    return last !== undefined && last.revision === revision && last.over === client;
  }

  /** Syncs one box now, whatever was placed before: also how a box's drift is looked for on demand. Never throws. */
  async syncBox(boxId: string): Promise<BoxSyncStatus> {
    const box = this.deps.boxes().find(entry => entry.id === boxId);
    const client = this.deps.client(boxId);
    if (box !== undefined && client !== undefined) {
      const revision = this.deps.library.revision();
      try {
        const skills = this.deps.library.list().map(skill => {
          const files = this.deps.library.filesOf(skill);
          if (files === undefined) throw new Error(`the library's copy of ${skill.slug} v${skill.version} is not what was published; publish it again`);
          return { slug: skill.slug, digest: skill.digest, files };
        });
        // An organisation that never published anything has nothing in any box: no box is asked anything.
        const result = this.deps.library.acts().length === 0 ? { written: [], removed: [], drift: [] } : await placeOrgSkills(client, box.root, skills);
        this.last.set(boxId, { revision, over: client, at: (this.deps.now?.() ?? new Date()).toISOString(), drift: result.drift });
        this.errors.delete(boxId);
        if (result.written.length + result.removed.length > 0) {
          this.deps.log(`organisation skills: ${box.name}: placed ${result.written.join(", ") || "none"}; removed ${result.removed.join(", ") || "none"}`);
          this.deps.placed?.(boxId, result);
        }
        if (result.drift.length > 0) this.deps.log(`organisation skills: ${box.name}: changed in the box and written over: ${result.drift.join(", ")}`);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        if (this.errors.get(boxId) !== why) this.deps.log(`organisation skills: ${box.name}: not synced: ${why}`);
        this.errors.set(boxId, why);
      }
    }
    return this.status().find(status => status.boxId === boxId) ?? { boxId, state: "offline", drift: [] };
  }

  /**
   * Syncs every connected box that is not current. One pass at a time: a change that arrives
   * during a pass runs another after it, so the last publish is never the one that was missed.
   */
  syncDue(): Promise<void> {
    if (this.busy) {
      this.again = true;
      return this.pass;
    }
    // A flag and not "is there a promise": a pass with nobody connected ends before its promise is even assigned.
    this.busy = true;
    this.pass = (async () => {
      try {
        do {
          this.again = false;
          const revision = this.deps.library.revision();
          for (const box of this.deps.boxes()) {
            const client = this.deps.client(box.id);
            // A box whose sync failed is not current, so the next pass tries it again; the failure is logged once.
            if (client === undefined || this.current(box.id, client, revision)) continue;
            await this.syncBox(box.id);
          }
        } while (this.again);
      } finally {
        this.busy = false;
      }
    })();
    return this.pass;
  }

  /** Where each box stands, for the Admin's page. */
  status(): BoxSyncStatus[] {
    const revision = this.deps.library.revision();
    return this.deps.boxes().map(box => {
      const client = this.deps.client(box.id);
      const last = this.last.get(box.id);
      const error = this.errors.get(box.id);
      const state: BoxSyncState = client === undefined ? "offline" : this.current(box.id, client, revision) ? "current" : "behind";
      return { boxId: box.id, state, ...(last !== undefined ? { syncedAt: last.at } : {}), ...(error !== undefined ? { error } : {}), drift: last?.drift ?? [] };
    });
  }
}

/** What of the orchestrator the organisation's skills are attached to. */
export interface OrgSkillsHost {
  registry: { listBoxes(): readonly (BoxPlace & { id: string; name: string })[]; boxById(id: string): BoxPlace };
  boxClientById(boxId: string): OrgSkillBox | undefined;
  skillsFor(boxId: string): { refresh(force?: boolean): Promise<unknown> };
  orgSkillRoot: (boxId: string) => OrgSkillRoot | undefined;
  boxConnected: (boxId: string) => void;
}

/**
 * Attaches the library to a running host: every box's loader reads the organisation's directory
 * as a second root, a box is synced when it connects and when the library changes, and a box's
 * skills are read again once a sync changed them. On a personal installation there are no boxes
 * to sync and no second root: nothing is placed and nothing is read.
 */
export function attachOrgSkills(host: OrgSkillsHost, library: OrgSkills, log: (line: string) => void): OrgSkillSync {
  const organisation = () => library.mode() !== "single-machine";
  const sync = new OrgSkillSync({
    library,
    boxes: () => (organisation() ? host.registry.listBoxes().map(box => ({ id: box.id, name: box.name, root: orgSkillsDir(box) })) : []),
    client: boxId => host.boxClientById(boxId),
    placed: boxId => { void host.skillsFor(boxId).refresh(true); },
    log,
  });
  // No second root while there is nothing in it: an organisation with no skills reads its boxes exactly as a personal installation does.
  host.orgSkillRoot = boxId => (organisation() && library.list().length > 0 ? { root: orgSkillsDir(host.registry.boxById(boxId)), required: library.required() } : undefined);
  host.boxConnected = () => { void sync.syncDue(); };
  library.changed = () => { void sync.syncDue(); };
  return sync;
}
