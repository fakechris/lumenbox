/**
 * The organisation's skills, from the page (INV-2222, docs/109 §6): an Admin publishes a skill,
 * updates it, withdraws it, marks it required, and sees which boxes hold what the library says.
 * Admin only, every route; and only on an organisation — a personal installation has no library.
 *
 * A skill is published from one of three places, all ending in the same check (`publishRefusal`):
 * files the Admin uploaded (`files`), a skill of a template document (`template`, `skill`), or a
 * skill in a box the Admin may enter (`box`, `skill`). Publishing a name that is already
 * published is an update: a new version. The boxes are synced by the library's own change
 * (`attachOrgSkills`), not by the request: with hundreds of boxes the answer does not wait for
 * them, and the page shows who is behind until they are not.
 */

import type { ErrorCode } from "../i18n/server-errors.ts";
import type { InstallationMode } from "../host/installation.ts";
import { attachOrgSkills, type BoxSyncStatus, type OrgSkillSync, type OrgSkillsHost } from "../host/org-skill-sync.ts";
import { type OrgSkillRefusal, OrgSkills, type SkillFiles, slugFor } from "../host/org-skills.ts";
import { IMPORT_MAX_FILES } from "../host/skill-import.ts";
import { parseSkillFile, SKILL_FILENAME } from "../host/skills.ts";
import { parseTemplate } from "../host/template.ts";
import { apiError } from "./api-error.ts";

const REFUSAL: Record<OrgSkillRefusal, { status: number; code: ErrorCode }> = {
  personal: { status: 409, code: "org-skill-personal" },
  invalid: { status: 400, code: "org-skill-invalid" },
  credential: { status: 400, code: "org-skill-credential" },
  unknown: { status: 404, code: "org-skill-unknown" },
  unchanged: { status: 409, code: "org-skill-unchanged" },
};

/** Just enough of a box to read one of its skills. */
export interface SkillBox {
  listDir(path: string): Promise<{ entries: { name: string; type: string }[] }>;
  readFile(path: string): Promise<{ content: string; truncated?: boolean }>;
}

export interface OrgSkillRouteDeps {
  library: OrgSkills;
  sync: Pick<OrgSkillSync, "status" | "syncBox">;
  /** The boxes of the installation the caller may enter, with each one's own skills directory. */
  boxes: () => readonly { id: string; name: string; skills: string }[];
  box: (boxId: string) => SkillBox | undefined;
  readJson: () => Promise<Record<string, unknown>>;
  params: URLSearchParams;
  /** Answers the refusal itself and returns true when the caller is not an Admin. */
  refusedAdmin: () => boolean;
  /** The signed-in person's principal id, or the operator's key. */
  by: () => string;
  nameOf: (principalId: string) => string;
  log: (line: string) => void;
}

/** A skill's files read out of a box: text files only, as an import reads a folder. */
async function readBoxSkill(box: SkillBox, dir: string): Promise<SkillFiles | string> {
  const files: Record<string, string> = {};
  const walk = async (at: string, prefix: string): Promise<string | undefined> => {
    for (const entry of (await box.listDir(at)).entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.type === "directory") {
        const problem = await walk(`${at}/${entry.name}`, `${prefix}${entry.name}/`);
        if (problem !== undefined) return problem;
      } else if (entry.type === "file") {
        if (Object.keys(files).length >= IMPORT_MAX_FILES) return `it has more than ${IMPORT_MAX_FILES} files`;
        const read = await box.readFile(`${at}/${entry.name}`);
        if (read.truncated === true) return `${prefix}${entry.name} is too long to read whole`;
        files[`${prefix}${entry.name}`] = read.content;
      }
    }
    return undefined;
  };
  try {
    return (await walk(dir, "")) ?? files;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function orgSkillRoute(route: string, deps: OrgSkillRouteDeps): Promise<{ status: number; body: unknown } | undefined> {
  if (!/^(GET|POST) \/api\/org-skills(\/|$)/.test(route)) return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  if (deps.library.mode() === "single-machine") return { status: 409, body: apiError("org-skill-personal") };
  const view = () => {
    const boxes = deps.sync.status();
    const names = new Map(deps.boxes().map(box => [box.id, box.name]));
    const count = (state: BoxSyncStatus["state"]) => boxes.filter(box => box.state === state).length;
    return {
      skills: deps.library.list().map(skill => ({ ...skill, byName: deps.nameOf(skill.by) })),
      // A box holds every skill or is behind on the library as a whole: the counts are of boxes.
      boxes: { current: count("current"), behind: count("behind"), offline: count("offline"), each: boxes.map(box => ({ ...box, name: names.get(box.boxId) ?? box.boxId })) },
      sources: deps.boxes().map(box => ({ id: box.id, name: box.name })),
    };
  };
  if (route === "GET /api/org-skills") return { status: 200, body: view() };
  if (route === "GET /api/org-skills/box") {
    const from = deps.boxes().find(box => box.id === deps.params.get("box"));
    const client = from === undefined ? undefined : deps.box(from.id);
    if (from === undefined || client === undefined) return { status: 404, body: apiError("org-skill-box") };
    const entries = await client.listDir(from.skills).then(listed => listed.entries, () => []);
    return { status: 200, body: { skills: entries.filter(entry => entry.type === "directory" && !entry.name.startsWith(".")).map(entry => entry.name).sort() } };
  }
  if (route === "GET /api/org-skills/history") {
    return { status: 200, body: { acts: deps.library.acts().filter(act => act.slug === deps.params.get("slug")).map(act => ({ ...act, byName: deps.nameOf(act.by) })) } };
  }
  const body = await deps.readJson();
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const refused = (result: { code: OrgSkillRefusal; why: string }) => ({ status: REFUSAL[result.code].status, body: apiError(REFUSAL[result.code].code, { why: result.why }) });
  if (route === "POST /api/org-skills/publish") {
    let files: SkillFiles | undefined;
    let source = "upload";
    const skill = typeof body.skill === "string" ? body.skill : "";
    if (typeof body.box === "string") {
      const from = deps.boxes().find(box => box.id === body.box);
      const client = from === undefined ? undefined : deps.box(from.id);
      if (from === undefined || client === undefined || !/^[A-Za-z0-9._-]+$/.test(skill) || skill.startsWith(".")) return { status: 404, body: apiError("org-skill-box") };
      const read = await readBoxSkill(client, `${from.skills}/${skill}`);
      if (typeof read === "string") return { status: 400, body: apiError("org-skill-invalid", { why: `${skill} could not be read from ${from.name}: ${read}` }) };
      files = read;
      source = `box:${from.id}/${skill}`;
    } else if (body.template !== undefined) {
      const parsed = parseTemplate(body.template);
      if ("problem" in parsed) return { status: 400, body: apiError("org-skill-invalid", { why: parsed.problem }) };
      const found = parsed.template.skills.find(entry => entry.slug === skill || entry.name === skill);
      if (found === undefined) return { status: 400, body: apiError("org-skill-invalid", { why: `the template has no skill ${skill}; it has ${parsed.template.skills.map(entry => entry.slug).join(", ") || "none"}` }) };
      files = found.files;
      source = `template:${parsed.template.profile.name}`;
    } else if (typeof body.files === "object" && body.files !== null && !Array.isArray(body.files)) {
      files = Object.fromEntries(Object.entries(body.files as Record<string, unknown>).map(([path, text]) => [path, String(text)]));
    }
    if (files === undefined) return { status: 400, body: apiError("org-skill-source") };
    // The name it is published under: the one given, else the skill's place of origin, else its own name.
    const name = slug !== "" ? slug : source === "upload" ? slugFor(files) : skill !== "" && /^[a-z0-9][a-z0-9._-]*$/.test(skill) ? skill : slugFor(files);
    const result = deps.library.publish(name, files, deps.by(), source);
    if (!result.ok) return refused(result);
    deps.log(`organisation skills: ${deps.by()} published ${name} v${result.skill.version} (${parseSkillFile(files[SKILL_FILENAME] ?? "").meta.name ?? name}) from ${source}`);
    return { status: 200, body: { ...view(), published: result.skill.slug } };
  }
  if (route === "POST /api/org-skills/withdraw") {
    const result = deps.library.withdraw(slug, deps.by());
    if (!result.ok) return refused(result);
    deps.log(`organisation skills: ${deps.by()} withdrew ${slug}`);
    return { status: 200, body: view() };
  }
  if (route === "POST /api/org-skills/require") {
    const result = deps.library.require(slug, body.required === true, deps.by());
    if (!result.ok) return refused(result);
    deps.log(`organisation skills: ${deps.by()} marked ${slug} ${body.required === true ? "required" : "not required"}`);
    return { status: 200, body: view() };
  }
  if (route === "POST /api/org-skills/sync") {
    // "Look again": every connected box is read and put right, which is also how drift is looked for.
    await Promise.all(deps.sync.status().filter(box => box.state !== "offline").map(box => deps.sync.syncBox(box.boxId)));
    return { status: 200, body: view() };
  }
  return { status: 404, body: apiError("route-unknown", { route }) };
}

/** How often a box that connected unnoticed, or whose sync failed, is looked at again. */
const SWEEP_MS = 30_000;

/** The library under `home`, attached to the running host and kept in step with its boxes: what the server starts once. */
export function startOrgSkills(input: { home: string; host: OrgSkillsHost; mode: () => InstallationMode; held: () => ReadonlyMap<string, string>; log: (line: string) => void }): { library: OrgSkills; sync: OrgSkillSync } {
  const library = new OrgSkills(input.home, { mode: input.mode, held: input.held });
  const sync = attachOrgSkills(input.host, library, input.log);
  setInterval(() => { void sync.syncDue(); }, SWEEP_MS).unref();
  void sync.syncDue();
  return { library, sync };
}
