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
 * - **Cheap when nothing changed.** A box keeps `.placed.json`: slug → the digest the server last
 *   placed. The sweep asks a box that was current for that one file and compares it with what the
 *   library says: one small request, and nothing in the box is hashed or read. Every file is read
 *   back only where drift is looked for — when a box connects, when the library changed, and when
 *   an Admin presses "Sync and check now" — so a change made inside a box is found then, not by
 *   the sweep.
 * - **Bounded.** A pass syncs `CONCURRENCY` boxes at a time and gives each `BOX_TIMEOUT_MS`: a
 *   box that is slow or dead is marked behind with the reason and does not hold up the others,
 *   and it is not started on again while its last attempt is still running.
 * - **Delegated engines** read their own skills directory, which the image links to the box's
 *   own (`docker/box/Dockerfile`). So each organisation skill is also linked *into* the box's
 *   skills directory, `<skills>/<slug>` → `../.lumenbox/org-skills/<slug>`, wherever the box has
 *   no skill of that name: the engine reads it through the link and cannot write it (the modes
 *   are the target's). The host's own loader lists directories and not links, so it meets each
 *   skill once, at its real place. A box's own skill of the same name is what the engine reads.
 * - **What an Admin sees.** `status()` per box: `current`, `behind` (connected, not yet at the
 *   library's revision — a sync is on its way or failed, with the error), `offline` (not connected:
 *   synced when it comes back), and the drift found by the last sync.
 */

import type { BusEvent } from "../agents/bus.ts";
import type { ExecResult } from "../protocol/index.ts";
import { type BoxPlace, orgSkillsDir, skillsDir, workDir } from "./box-paths.ts";
import { OrgSkillSetup, type SetupBox } from "./org-skill-setup.ts";
import type { OrgSkill, OrgSkills, SkillFiles } from "./org-skills.ts";
import { type OrgSkillRoot, parseSkillFile, SKILL_FILENAME, skillSetupFrom } from "./skills.ts";

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
export async function placeOrgSkills(
  box: OrgSkillBox,
  root: string,
  skills: readonly { slug: string; digest: string; files: SkillFiles }[],
  /** `glance`: when the box's own record says it holds this, believe it — one request. `skillsDir`: the box's own skills directory, for the engines' links. */
  options: { glance?: boolean; skillsDir?: string } = {}
): Promise<PlaceResult> {
  const manifest = `${JSON.stringify(Object.fromEntries(skills.map(skill => [skill.slug, skill.digest])))}\n`;
  const kept = skills.length === 0 && options.glance === true ? undefined : await box.downloadFile(`${root}/${MANIFEST}`).then(file => Buffer.from(file.base64, "base64").toString("utf8"), () => undefined);
  if (options.glance === true && skills.length > 0 && kept === manifest) return { written: [], removed: [], drift: [] };
  const present = await box.listDir(root).then(listed => listed.entries, () => undefined);
  const link = (slugs: readonly string[]) => (options.skillsDir === undefined ? Promise.resolve() : shell(box, linkLine(options.skillsDir, slugs)));
  if (skills.length === 0) {
    // The last skill was withdrawn: the directory goes with it. One that was never there is not made.
    if (present === undefined) return { written: [], removed: [], drift: [] };
    await shell(box, `chmod -R u+w ${quoted(root)} 2>/dev/null; rm -rf ${quoted(root)}`);
    await link([]);
    return { written: [], removed: present.filter(entry => entry.name !== MANIFEST).map(entry => entry.name), drift: [] };
  }
  let placed: Record<string, string> = {};
  try { placed = kept === undefined ? {} : (JSON.parse(kept) as Record<string, string>); } catch { /* not ours any more: everything in it is drift */ }
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
    await box.writeFile(`${root}/${MANIFEST}`, manifest);
  } else if (kept !== manifest) {
    await shell(box, `chmod u+w ${quoted(root)} ${quoted(`${root}/${MANIFEST}`)} 2>/dev/null; true`);
    await box.writeFile(`${root}/${MANIFEST}`, manifest);
  }
  // Every sync that looked, changed or not: a mode somebody opened is closed again, and the engines' links are what they should be.
  await shell(box, `chmod -R a-w ${quoted(root)}`);
  await link(skills.map(skill => skill.slug));
  return { written, removed, drift };
}

/** Where an organisation skill's link in the box's own skills directory points: relative, so it holds wherever the work directory is. */
const LINK_TARGET = "../.lumenbox/org-skills";

/**
 * One line that makes the box's skills directory link exactly `slugs` to the organisation's
 * directory: links of ours that are no longer wanted go, and a name the box already has —
 * its own skill, or anything else — is left alone.
 */
export function linkLine(skillsDir: string, slugs: readonly string[]): string {
  const stale = `for l in * .[!.]*; do [ -L "$l" ] || continue; case "$(readlink "$l")" in ${LINK_TARGET}/*) rm -f "$l";; esac; done`;
  const make = slugs.map(slug => `{ [ -e ${quoted(slug)} ] || [ -L ${quoted(slug)} ] || ln -s ${quoted(`${LINK_TARGET}/${slug}`)} ${quoted(slug)}; }`).join("; ");
  return `cd ${quoted(skillsDir)} 2>/dev/null || exit 0; ${stale}${make === "" ? "" : `; ${make}`}; true`;
}

/** Whether `work` finished within `ms`; it is left running either way. */
async function within(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">(resolve => { timer = setTimeout(() => resolve("late"), ms); });
  const outcome = await Promise.race([work.then(() => "done" as const), late]);
  clearTimeout(timer);
  return outcome === "done";
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
  /** The installation's boxes, and each one's client when it is connected. `skills` is the box's own skills directory, for the engines' links. */
  boxes: () => readonly { id: string; name: string; root: string; skills?: string }[];
  client: (boxId: string) => OrgSkillBox | undefined;
  /** Told after a sync changed a box, so its skills are read again before the next turn. */
  placed?: (boxId: string, result: PlaceResult) => void;
  /** Awaited after every sync of a box that looked at it whole: what the skills ask of the box is checked then (`org-skill-setup.ts`). */
  synced?: (boxId: string) => Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
  /** How many boxes a pass syncs at once, and how long one box is given. */
  concurrency?: number;
  boxTimeoutMs?: number;
}

/** Eight at a time: hundreds of boxes in tens of seconds when all must be written, and no more than eight requests in flight on the server's side. */
export const CONCURRENCY = 8;
/** A box that has not finished in a minute is behind, and the pass goes on without it. */
export const BOX_TIMEOUT_MS = 60_000;

/** Keeps every connected box at the library's revision, and says where each stands. */
export class OrgSkillSync {
  private readonly last = new Map<string, { revision: string; over: OrgSkillBox; at: string; drift: string[] }>();
  private readonly errors = new Map<string, string>();
  /** Boxes whose last attempt has not come back: not started on again until it does. */
  private readonly inFlight = new Map<string, Promise<void>>();
  private held: { revision: string; skills: { slug: string; digest: string; files: SkillFiles }[] } | undefined;
  private busy = false;
  private again = false;
  private pass: Promise<void> = Promise.resolve();

  constructor(private readonly deps: OrgSkillSyncDeps) {}

  /** Whether a connected box holds what the library says, over the connection it has now. */
  private current(boxId: string, client: OrgSkillBox, revision: string): boolean {
    const last = this.last.get(boxId);
    return last !== undefined && last.revision === revision && last.over === client;
  }

  /**
   * Syncs one box now. `full` reads every file back, which is how drift is found: on connect, on a
   * change, on demand. `glance` asks the box for the one record it keeps. Never throws; a box
   * that does not finish in time is behind with that as the reason, and is left to finish.
   */
  async syncBox(boxId: string, mode: "full" | "glance" = "full", options: { waitForRunning?: boolean } = {}): Promise<BoxSyncStatus> {
    const limit = this.deps.boxTimeoutMs ?? BOX_TIMEOUT_MS;
    // Asked for by a person ("Sync and check now"): an attempt already running is waited for, within the limit, and then this one looks for itself.
    const running = this.inFlight.get(boxId);
    if (running !== undefined && options.waitForRunning === true) await within(running, limit);
    const box = this.deps.boxes().find(entry => entry.id === boxId);
    const client = this.deps.client(boxId);
    if (box !== undefined && client !== undefined && !this.inFlight.has(boxId)) {
      const revision = this.deps.library.revision();
      const fail = (why: string) => {
        if (this.errors.get(boxId) !== why) this.deps.log(`organisation skills: ${box.name}: not synced: ${why}`);
        this.errors.set(boxId, why);
        if (mode === "glance") this.last.delete(boxId);
      };
      const work = (async () => {
        const skills = this.wanted(revision);
        // An organisation that never published anything has nothing in any box: no box is asked anything.
        const how = { glance: mode === "glance", ...(box.skills !== undefined ? { skillsDir: box.skills } : {}) };
        const result = this.deps.library.acts().length === 0 ? { written: [], removed: [], drift: [] } : await placeOrgSkills(client, box.root, skills, how);
        const before = this.last.get(boxId);
        // A glance finds no drift because it does not look: what the last full sync found stands.
        this.last.set(boxId, { revision, over: client, at: (this.deps.now?.() ?? new Date()).toISOString(), drift: mode === "glance" && result.written.length === 0 ? before?.drift ?? [] : result.drift });
        this.errors.delete(boxId);
        if (result.written.length + result.removed.length > 0) {
          this.deps.log(`organisation skills: ${box.name}: placed ${result.written.join(", ") || "none"}; removed ${result.removed.join(", ") || "none"}`);
          this.deps.placed?.(boxId, result);
        }
        if (result.drift.length > 0) this.deps.log(`organisation skills: ${box.name}: changed in the box and written over: ${result.drift.join(", ")}`);
        if (mode === "full" || result.written.length > 0) await this.deps.synced?.(boxId);
      })();
      const settled = work.then(() => undefined, (error: unknown) => fail(error instanceof Error ? error.message : String(error))).finally(() => this.inFlight.delete(boxId));
      this.inFlight.set(boxId, settled);
      if (!(await within(settled, limit))) fail(`it did not finish within ${limit / 1000} s`);
    }
    return this.status().find(status => status.boxId === boxId) ?? { boxId, state: "offline", drift: [] };
  }

  /**
   * Brings every connected box to the library, `concurrency` at a time. A box that is not
   * current gets a full sync; one that is gets a glance. One pass at a time: a change that
   * arrives during a pass runs another after it, so the last publish is never the one missed.
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
          const due = this.deps.boxes().flatMap(box => {
            const client = this.deps.client(box.id);
            return client === undefined ? [] : [{ id: box.id, mode: this.current(box.id, client, revision) ? ("glance" as const) : ("full" as const) }];
          });
          let next = 0;
          const worker = async () => {
            while (next < due.length) {
              const box = due[next++]!;
              await this.syncBox(box.id, box.mode);
            }
          };
          await Promise.all(Array.from({ length: Math.min(this.deps.concurrency ?? CONCURRENCY, due.length) }, worker));
        } while (this.again);
      } catch (error) {
        // Never a rejection: it runs from a timer and from connects nobody awaits. Said, and the next pass tries again.
        this.deps.log(`organisation skills: a sync pass stopped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.busy = false;
      }
    })();
    return this.pass;
  }

  /** What every box should hold, read from the library once per revision and not once per box. */
  private wanted(revision: string): { slug: string; digest: string; files: SkillFiles }[] {
    if (this.held?.revision !== revision) {
      const skills = this.deps.library.list().map(skill => {
        const files = this.deps.library.filesOf(skill);
        if (files === undefined) throw new Error(`the library's copy of ${skill.slug} v${skill.version} is not what was published; publish it again`);
        return { slug: skill.slug, digest: skill.digest, files };
      });
      this.held = { revision, skills };
    }
    return this.held.skills;
  }

  /** After the library changed: every box is looked at whole at the next pass, not glanced at. */
  forget(): void {
    for (const [boxId, last] of this.last) this.last.set(boxId, { ...last, revision: "" });
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
  registry: {
    listBoxes(): readonly (BoxPlace & { id: string; name: string })[];
    boxById(id: string): BoxPlace;
    tryGet(agentId: string): unknown;
    boxOf(agentId: string): { id: string };
    readTranscript(agentId: string, conversation?: string): unknown[];
  };
  boxClientById(boxId: string): (OrgSkillBox & SetupBox) | undefined;
  skillsFor(boxId: string): { refresh(force?: boolean): Promise<unknown> };
  orgSkillRoot: (boxId: string) => OrgSkillRoot | undefined;
  boxConnected: (boxId: string) => void;
  busNoted: (event: BusEvent) => void;
}

/** Whether the last thing said to an agent, as opposed to a tool's result, was said by a person. */
function personOpened(transcript: readonly unknown[]): boolean {
  for (let at = transcript.length - 1; at >= 0; at--) {
    const entry = transcript[at] as { role?: string; kind?: string; fromPerson?: boolean };
    if (entry?.role === "user" && entry.kind === undefined) return entry.fromPerson === true;
  }
  return false;
}

/**
 * Attaches the library to a running host: every box's loader reads the organisation's directory
 * as a second root, a box is synced when it connects and when the library changes, a box's
 * skills are read again once a sync changed them, and what the required skills ask of a box is
 * checked after it is synced and said to its agents once. On a personal installation there are no
 * boxes to sync and no second root: nothing is placed and nothing is read.
 */
export function attachOrgSkills(host: OrgSkillsHost, library: OrgSkills, log: (line: string) => void, setupLedger?: string): { sync: OrgSkillSync; setup: OrgSkillSetup } {
  const organisation = () => library.mode() !== "single-machine";
  const place = (boxId: string) => ({ work: workDir(host.registry.boxById(boxId)), root: orgSkillsDir(host.registry.boxById(boxId)) });
  const setup = new OrgSkillSetup(setupLedger, {
    client: boxId => host.boxClientById(boxId),
    place,
    personOpened: (agentId, conversation) => personOpened(host.registry.readTranscript(agentId, conversation)),
    boxOf: agentId => (host.registry.tryGet(agentId) === undefined ? undefined : host.registry.boxOf(agentId).id),
    log,
  });
  // What each required skill declares, read from the library's own copy: the same text every box holds.
  const declared = () => library.list().filter(skill => skill.required).map(skill => {
    const parsed = skillSetupFrom(skill.slug, parseSkillFile(library.filesOf(skill)?.[SKILL_FILENAME] ?? "").meta);
    return { slug: skill.slug, ...("setup" in parsed && parsed.setup !== undefined ? { setup: parsed.setup } : {}) };
  });
  const sync = new OrgSkillSync({
    library,
    boxes: () => (organisation() ? host.registry.listBoxes().map(box => ({ id: box.id, name: box.name, root: orgSkillsDir(box), skills: skillsDir(box) })) : []),
    client: boxId => host.boxClientById(boxId),
    placed: boxId => { void host.skillsFor(boxId).refresh(true); },
    synced: async boxId => {
      await setup.check(boxId, declared());
      await host.skillsFor(boxId).refresh(true);
    },
    log,
  });
  // No second root while there is nothing in it: an organisation with no skills reads its boxes exactly as a personal installation does.
  host.orgSkillRoot = boxId => (organisation() && library.list().length > 0
    ? { root: orgSkillsDir(host.registry.boxById(boxId)), required: library.required(), due: skill => setup.due(boxId, skill) }
    : undefined);
  host.boxConnected = () => { void sync.syncDue(); };
  host.busNoted = event => { if (event.type === "turn_finished") setup.noteTurn(event); };
  // A required mark changes what is owed without changing what is placed: the boxes are looked at whole again.
  library.changed = () => { sync.forget(); void sync.syncDue(); };
  return { sync, setup };
}
