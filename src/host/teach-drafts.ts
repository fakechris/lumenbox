/** Host-owned teaching proposals. A model can return text, never publish a skill. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BoxClient } from "../box/client.ts";
import { loadSkills, parseSkillFile, skillFrom, SKILLS_DIR, slugify } from "./skills.ts";
import { namesControlSurface } from "./control-surfaces.ts";
import { SkillHistory, type SkillVersion } from "./skill-history.ts";
import { CASE_PASS_RATE, casesPass, type Operation, type OperationCase, operationProblem, runCases } from "./operation.ts";
export { SkillHistory } from "./skill-history.ts";
import { isDisplayIndex } from "../protocol/index.ts";

export interface TeachClarification {
  question: string;
  answer: string;
  actor: string;
  at: string;
  digest: string;
}

export interface TeachProposal {
  boxId: string;
  agentId: string;
  sessionId: string;
  eventsPath: string;
  taskId?: string;
  display?: number;
  epoch?: number;
  videoPath?: string;
  skill: string | null;
  question: string | null;
  clarifications?: TeachClarification[];
  /** Credential kinds removed from the trace before the teaching model read it (INV-1368); never values. */
  redactedCredentials?: string[];
  /**
   * Where a draft came from when not a demonstration: an import (INV-1367), or an evaluation's
   * learning material (INV-1377) proposing a revision of the existing skill `skillDir`, resting on
   * the failing tasks in `basis`.
   */
  source?: { kind: "import"; from: string } | { kind: "eval"; from: string; skillDir: string; basis: string[] };
  /** Helper files published beside SKILL.md, relative path → text (imports only). */
  files?: Record<string, string>;
  /** allowed-tools names the import could not map onto ours; dropped, shown to the reviewer. */
  unknownTools?: string[];
}

/** Accept an entire Markdown wrapper, never extract JSON from surrounding prose. */
export function parseTeachingResponse(response: string): Pick<TeachProposal, "skill" | "question" | "files"> {
  const unwrap = (text: string, languages: string) => {
    const match = new RegExp("^```(?:" + languages + ")?\\r?\\n([\\s\\S]*?)\\r?\\n```$").exec(text.trim());
    return match ? match[1]! : text;
  };
  let value: unknown;
  try { value = JSON.parse(unwrap(response, "json")); }
  catch { throw new Error("Teaching response must contain one JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Teaching response must be an object");
  const proposal = value as Record<string, unknown>;
  if ((proposal.skill !== null && typeof proposal.skill !== "string") ||
      (proposal.question !== null && typeof proposal.question !== "string")) throw new Error("Teaching response needs skill and question fields");
  const skill = typeof proposal.skill === "string" ? unwrap(proposal.skill, "markdown|md") : null;
  // An operation (INV-1378) rides as two files beside the skill; a broken one is refused here,
  // before a draft exists, rather than published and found broken at the first run.
  if (skill !== null && proposal.operation !== undefined && proposal.operation !== null) {
    const problem = operationProblem(proposal.operation);
    if (problem !== undefined) throw new Error(`Teaching response's operation is invalid: ${problem}`);
    const cases = Array.isArray(proposal.cases) ? proposal.cases.filter(one => one && typeof one === "object" && typeof (one as { purpose?: unknown }).purpose === "string").slice(0, 20) : [];
    if (cases.length === 0) throw new Error("An operation needs cases: at least one, each with a purpose and an input");
    return { skill, question: null, files: { "operation.json": `${JSON.stringify(proposal.operation, null, 2)}\n`, "cases.json": `${JSON.stringify(cases, null, 2)}\n` } };
  }
  return { skill, question: proposal.question as string | null };
}

/** A draft that carries an operation (INV-1378): its parsed operation and cases, or undefined. */
export function operationOf(draft: Pick<TeachProposal, "files">): { operation: Operation; cases: OperationCase[] } | undefined {
  const op = draft.files?.["operation.json"];
  if (op === undefined) return undefined;
  return { operation: JSON.parse(op) as Operation, cases: JSON.parse(draft.files?.["cases.json"] ?? "[]") as OperationCase[] };
}

export interface TeachDraft extends TeachProposal {
  id: string;
  digest: string;
  createdAt: string;
  status: "draft" | "publishing" | "published" | "rejected";
  approvedBy?: string;
  approvedAt?: string;
  /** The last dry run of an operation draft's cases (INV-1378); not part of the digest. */
  dryRun?: { passed: number; total: number; failures: string[]; at: string };
}

type Publish = (boxId: string, path: string, content: string) => Promise<void>;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const idFor = (boxId: string, sessionId: string) => hash(JSON.stringify([boxId, sessionId]));
const digestOf = (p: TeachProposal) => hash(JSON.stringify([p.boxId, p.agentId, p.sessionId, p.eventsPath, p.videoPath ?? null, p.skill, p.question, ...(p.display === undefined && p.epoch === undefined && p.taskId === undefined ? [] : [{ display: p.display, epoch: p.epoch, taskId: p.taskId }]), ...(p.clarifications === undefined ? [] : [p.clarifications]), ...(p.redactedCredentials === undefined ? [] : [{ redactedCredentials: p.redactedCredentials }]), ...(p.source === undefined ? [] : [{ source: p.source, files: p.files ?? null, unknownTools: p.unknownTools ?? null }])]));

function validateProposal(p: TeachProposal): void {
  for (const value of [p.boxId, p.agentId, p.sessionId, p.eventsPath]) {
    if (typeof value !== "string" || value.trim() === "" || value.length > 4096) throw new Error("Invalid teaching identity");
  }
  if (p.display !== undefined && !isDisplayIndex(p.display)) throw new Error("Invalid teaching display");
  if (p.epoch !== undefined && (!Number.isSafeInteger(p.epoch) || p.epoch < 0)) throw new Error("Invalid teaching epoch");
  if (p.taskId !== undefined && (typeof p.taskId !== "string" || !p.taskId.trim() || p.taskId.length > 256)) throw new Error("Invalid teaching task");
  if (p.videoPath !== undefined && typeof p.videoPath !== "string") throw new Error("Invalid teaching video");
  if (p.source !== undefined && ((p.source.kind !== "import" && p.source.kind !== "eval") || typeof p.source.from !== "string" || !p.source.from.trim() || p.source.from.length > 4096)) throw new Error("Invalid import source");
  if (p.source?.kind === "eval" && (!/^[A-Za-z0-9._-]{1,120}$/.test(p.source.skillDir) || !Array.isArray(p.source.basis) || p.source.basis.length > 64 || p.source.basis.some(id => typeof id !== "string" || id.length > 120))) throw new Error("Invalid evaluation source");
  if (p.files !== undefined) {
    const entries = typeof p.files === "object" && p.files !== null ? Object.entries(p.files) : [];
    const operationOnly = entries.every(([path]) => path === "operation.json" || path === "cases.json") && entries.some(([path]) => path === "operation.json");
    if ((p.source === undefined && !operationOnly) || entries.length === 0 || entries.length > 50 ||
        entries.some(([path, content]) => typeof content !== "string" || content.length > 512 * 1024 || !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path) ||
          path.split("/").some(part => part === ".." || part === ".") || path === "SKILL.md")) throw new Error("Invalid imported files");
  }
  if (p.files?.["operation.json"] !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(p.files["operation.json"]); } catch { throw new Error("Invalid operation: not JSON"); }
    const problem = operationProblem(parsed);
    if (problem !== undefined) throw new Error(`Invalid operation: ${problem}`);
  }
  if (p.unknownTools !== undefined && (!Array.isArray(p.unknownTools) || p.unknownTools.length > 64 || p.unknownTools.some(name => typeof name !== "string" || name.length > 128))) throw new Error("Invalid unknown tools");
  if (p.redactedCredentials !== undefined && (!Array.isArray(p.redactedCredentials) || p.redactedCredentials.length > 32 ||
      p.redactedCredentials.some(kind => typeof kind !== "string" || !/^[a-z0-9-]{1,40}$/.test(kind)))) throw new Error("Invalid teaching redaction note");
  if (p.clarifications !== undefined) {
    if (!Array.isArray(p.clarifications) || p.clarifications.length > 10) throw new Error("Invalid teaching clarification history");
    for (const entry of p.clarifications) {
      if (!entry || [entry.question, entry.answer].some(value => typeof value !== "string" || !value.trim() || value.length > 4096) ||
          typeof entry.actor !== "string" || !entry.actor.trim() || entry.actor.length > 256 ||
          typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at)) ||
          typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest)) throw new Error("Invalid teaching clarification history");
    }
  }
  if (p.skill === null) {
    if (typeof p.question !== "string" || p.question.trim() === "" || p.question.length > 4096) throw new Error("A teaching question is required");
  } else {
    if (typeof p.skill !== "string" || p.skill.length > 65536 || p.question !== null) throw new Error("Invalid teaching skill");
    // A teaching recipe is bounded prose, not a trace dump. Keep it below the
    // normal file reader's 2000-line window so every formal consumer sees all of it.
    if (p.skill.split("\n").length > 1000) throw new Error("Teaching skills must be at most 1000 lines");
    if (namesControlSurface(p.skill)) throw new Error("Teaching skill names a protected control surface");
    const parsed = parseSkillFile(p.skill);
    const result = skillFrom("teaching", parsed);
    if ("problem" in result || !parsed.meta.name || parsed.meta.scope !== "global") throw new Error("Teaching skill needs name, description, scope: global and a body");
    // Publishing a teaching result must not also install an unattended routine.
    // An import may carry allowed-tools, already mapped onto ours; nothing that runs unattended.
    const allowedKeys = p.source !== undefined ? ["name", "description", "scope", "allowed-tools"] : ["name", "description", "scope"];
    if (Object.keys(parsed.meta).some(key => !allowedKeys.includes(key))) throw new Error("Teaching drafts cannot install a schedule, listener or other execution metadata");
  }
}

/** The real box publication path, shared by the host and filesystem integration tests. */
export async function publishTeachingSkill(box: Pick<BoxClient, "writeFile" | "uploadFile" | "readFile" | "listDir">, path: string, content: string): Promise<void> {
  if (!path.endsWith("/SKILL.md")) {
    // A helper file beside an imported skill (INV-1367): written and read back; nothing loads it alone.
    await box.writeFile(path, content);
    const back = await box.readFile(path);
    if (back.truncated || back.content !== content) throw new Error(`Published helper file verification failed: ${path}`);
    return;
  }
  // /fs/upload is atomic but requires its parent directory to exist. The harmless
  // provenance file creates that directory without exposing a partial SKILL.md.
  await box.writeFile(`${dirname(path)}/publication.json`, JSON.stringify({ source: "teaching", sha256: hash(content) }));
  await box.uploadFile(path, Buffer.from(content).toString("base64"));
  const read = await box.readFile(path);
  if (read.truncated || read.content !== content) throw new Error("Published skill verification failed");
  // Refreshing the current box's TTL cache proves nothing about this target box.
  const loaded = await loadSkills(box);
  if (!loaded.skills.some(skill => skill.path === path)) throw new Error("Published teaching skill is not loadable");
}

/** Single hostd writer, like TaskStore. Drafts live outside every box's formal skill roots. */
/** Where a draft publishes in the box: imported-<slug>-<id> for an import, taught-<id> for a demonstration. */
export function publishDirOf(draft: Pick<TeachDraft, "id" | "source" | "skill">): string {
  if (draft.source?.kind === "eval") return draft.source.skillDir; // a revision publishes over the skill it revises
  return draft.source?.kind === "import" ? `imported-${slugify(parseSkillFile(draft.skill ?? "").meta.name ?? "skill")}-${draft.id.slice(0, 8)}` : `taught-${draft.id}`;
}

export class TeachDrafts {
  private readonly publishing = new Map<string, Promise<TeachDraft>>();
  /** `history` (INV-1376) records drafts and publishes; absent, nothing is recorded. */
  constructor(private readonly root: string, private readonly history?: SkillHistory) {}

  /** History is a record of the gate, not the gate: a failure to write it is logged, never fatal. */
  private recordHistory(what: string, write: (history: SkillHistory) => void): void {
    if (this.history === undefined) return;
    try {
      write(this.history);
    } catch (error) {
      console.error(`[skill-history] could not record ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  forSession(boxId: string, sessionId: string): TeachDraft | undefined {
    const id = idFor(boxId, sessionId);
    return existsSync(this.path(id)) ? this.get(id) : undefined;
  }

  create(proposal: TeachProposal): TeachDraft {
    validateProposal(proposal);
    const existing = this.forSession(proposal.boxId, proposal.sessionId);
    if (existing) return existing; // A queue retry cannot replace the text a person reviewed.
    const draft: TeachDraft = { ...proposal, id: idFor(proposal.boxId, proposal.sessionId), digest: digestOf(proposal), createdAt: new Date().toISOString(), status: "draft" };
    this.save(draft);
    if (draft.skill !== null) {
      this.recordHistory(`draft ${draft.id}`, history => history.recordDraft({ id: draft.id, agentName: draft.agentId, source: draft.source?.from ?? draft.eventsPath, files: { ...(draft.files ?? {}), "SKILL.md": draft.skill! } }));
    }
    return draft;
  }

  get(id: string): TeachDraft {
    const d = JSON.parse(readFileSync(this.path(id), "utf8")) as TeachDraft;
    validateProposal(d);
    if (d.id !== id || id !== idFor(d.boxId, d.sessionId) || d.digest !== digestOf(d) || typeof d.createdAt !== "string" || !["draft", "publishing", "published", "rejected"].includes(d.status)) throw new Error("Corrupt teaching draft");
    if (["publishing", "published"].includes(d.status) && (typeof d.approvedBy !== "string" || !d.approvedBy || typeof d.approvedAt !== "string")) throw new Error("Teaching approval is missing");
    return d;
  }

  list(): TeachDraft[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter(name => name.endsWith(".json")).map(name => this.get(name.slice(0, -5))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  reject(id: string, digest: string): TeachDraft {
    const draft = this.reviewed(id, digest);
    if (draft.status !== "draft" && draft.status !== "rejected") throw new Error("Publication has already been approved");
    draft.status = "rejected";
    this.save(draft);
    return draft;
  }

  async clarify(id: string, digest: string, answer: string, actor: string,
    generate: (draft: TeachDraft, answer: string) => Promise<Pick<TeachProposal, "skill" | "question" | "files">>): Promise<TeachDraft> {
    const original = this.reviewedQuestion(id, digest);
    if (typeof answer !== "string" || !answer.trim() || answer.length > 4096 ||
        typeof actor !== "string" || !actor.trim() || actor.length > 256) throw new Error("Provide a bounded clarification and its operator");
    if ((original.clarifications?.length ?? 0) >= 10) throw new Error("This demonstration has too many clarification rounds; record a new demonstration");
    const response = await generate(original, answer.trim());
    // Reject, another answer, or publication while the model was running wins.
    const current = this.reviewedQuestion(id, digest);
    const revised: TeachDraft = { ...current, skill: response.skill, question: response.question, ...(response.files !== undefined ? { files: response.files } : {}),
      clarifications: [...(current.clarifications ?? []), { question: current.question!, answer: answer.trim(), actor,
        at: new Date().toISOString(), digest: current.digest }] };
    validateProposal(revised);
    revised.digest = digestOf(revised);
    this.save(revised); // The question and its answer move together in one atomic file.
    return revised;
  }

  private reviewedQuestion(id: string, digest: string): TeachDraft {
    const draft = this.reviewed(id, digest);
    if (draft.status !== "draft" || draft.skill !== null) throw new Error("Only an open teaching question can be clarified");
    return draft;
  }

  async approve(id: string, digest: string, actor: string, publish: Publish): Promise<TeachDraft> {
    const draft = this.reviewed(id, digest);
    if (!actor.trim()) throw new Error("An approving operator is required");
    if (draft.status === "rejected" || draft.skill === null) throw new Error("This draft cannot be published");
    if (operationOf(draft) !== undefined && draft.status === "draft" && (draft.dryRun === undefined || !casesPass(draft.dryRun))) {
      throw new Error(`An operation is published only after a dry run passes at least ${Math.round(CASE_PASS_RATE * 100)}% of its cases${draft.dryRun ? ` (last: ${draft.dryRun.passed}/${draft.dryRun.total})` : ""}`);
    }
    if (draft.status === "published") return draft;
    const active = this.publishing.get(id);
    if (active) return active;
    if (draft.status === "draft") {
      draft.status = "publishing";
      draft.approvedBy = actor;
      draft.approvedAt = new Date().toISOString();
      this.save(draft); // Durable approval precedes the remote effect, including retries.
    }
    const pending = (async () => {
      // A unique destination avoids replacing an unrelated, already published recipe. Helper files
      // first and SKILL.md last, so the skill is never loadable with half its files.
      const slug = publishDirOf(draft);
      const dir = `${SKILLS_DIR}/${slug}`;
      const at = new Date().toISOString();
      const record = { dir: slug, name: parseSkillFile(draft.skill!).meta.name ?? slug, files: { ...(draft.files ?? {}), "SKILL.md": draft.skill! }, actor: draft.approvedBy ?? actor, source: draft.source?.from ?? draft.eventsPath, draftId: draft.id };
      for (const [path, content] of Object.entries(draft.files ?? {})) await publish(draft.boxId, `${dir}/${path}`, content);
      // The card travels with the skill, generated here (INV-1376); the version is the one about to be tagged.
      if (this.history !== undefined) await publish(draft.boxId, `${dir}/CARD.md`, SkillHistory.card(record, this.history.nextVersion(slug), at));
      await publish(draft.boxId, `${dir}/SKILL.md`, draft.skill!);
      draft.status = "published";
      this.save(draft);
      this.recordHistory(`publish of ${slug}`, history => history.recordPublish(record, at));
      return draft;
    })();
    this.publishing.set(id, pending);
    try { return await pending; } finally { this.publishing.delete(id); }
  }

  /** Runs an operation draft's cases (INV-1378) and records the result on the draft; it never commits. */
  async dryRun(id: string, browser: Parameters<typeof runCases>[2]): Promise<TeachDraft> {
    const draft = this.get(id);
    const found = operationOf(draft);
    if (found === undefined) throw new Error("This draft has no operation to dry-run");
    if (draft.status !== "draft") throw new Error("Only an unpublished draft is dry-run");
    const result = await runCases(found.operation, found.cases, browser);
    const current = this.get(id);
    current.dryRun = { ...result, at: new Date().toISOString() };
    this.save(current);
    return current;
  }

  /** The published versions of a draft's skill, oldest first; empty without history or before a publish. */
  versions(id: string): SkillVersion[] {
    const draft = this.get(id);
    return this.history === undefined || draft.status !== "published" ? [] : this.history.versions(publishDirOf(draft));
  }

  /**
   * Publishes an earlier version of a published skill again, as a new version (INV-1376). History
   * is appended, never rewritten; the box gets the old files and a fresh CARD.md saying so.
   */
  async rollback(id: string, version: number, actor: string, publish: Publish): Promise<TeachDraft> {
    const draft = this.get(id);
    if (this.history === undefined) throw new Error("This installation keeps no skill history");
    if (draft.status !== "published") throw new Error("Only a published skill has versions to return to");
    if (!actor.trim()) throw new Error("A rolling-back operator is required");
    const slug = publishDirOf(draft);
    const files = this.history.filesAt(slug, version);
    if (files["SKILL.md"] === undefined) throw new Error(`Version ${version} has no SKILL.md`);
    const at = new Date().toISOString();
    const record = { dir: slug, name: parseSkillFile(files["SKILL.md"]).meta.name ?? slug, files, actor, source: draft.source?.from ?? draft.eventsPath, draftId: draft.id, note: `rollback to v${version}` };
    const dir = `${SKILLS_DIR}/${slug}`;
    for (const [path, content] of Object.entries(files)) if (path !== "SKILL.md") await publish(draft.boxId, `${dir}/${path}`, content);
    await publish(draft.boxId, `${dir}/CARD.md`, SkillHistory.card(record, this.history.nextVersion(slug), at));
    await publish(draft.boxId, `${dir}/SKILL.md`, files["SKILL.md"]);
    this.history.recordPublish(record, at);
    return draft;
  }

  private reviewed(id: string, digest: string): TeachDraft {
    const draft = this.get(id);
    if (draft.digest !== digest) throw new Error("The draft changed; review it again");
    return draft;
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid teaching draft id");
    return join(this.root, `${id}.json`);
  }

  private save(draft: TeachDraft): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(draft.id);
    const temp = `${path}.${randomUUID()}.part`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(draft)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
      const dir = openSync(this.root, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
}
