/** Host-owned teaching proposals. A model can return text, never publish a skill. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BoxClient } from "../box/client.ts";
import { loadSkills, parseSkillFile, skillFrom, SKILLS_DIR } from "./skills.ts";
import { namesControlSurface } from "./control-surfaces.ts";
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
}

/** Accept an entire Markdown wrapper, never extract JSON from surrounding prose. */
export function parseTeachingResponse(response: string): Pick<TeachProposal, "skill" | "question"> {
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
  return { skill: typeof proposal.skill === "string" ? unwrap(proposal.skill, "markdown|md") : null, question: proposal.question };
}

export interface TeachDraft extends TeachProposal {
  id: string;
  digest: string;
  createdAt: string;
  status: "draft" | "publishing" | "published" | "rejected";
  approvedBy?: string;
  approvedAt?: string;
}

type Publish = (boxId: string, path: string, content: string) => Promise<void>;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const idFor = (boxId: string, sessionId: string) => hash(JSON.stringify([boxId, sessionId]));
const digestOf = (p: TeachProposal) => hash(JSON.stringify([p.boxId, p.agentId, p.sessionId, p.eventsPath, p.videoPath ?? null, p.skill, p.question, ...(p.display === undefined && p.epoch === undefined && p.taskId === undefined ? [] : [{ display: p.display, epoch: p.epoch, taskId: p.taskId }]), ...(p.clarifications === undefined ? [] : [p.clarifications])]));

function validateProposal(p: TeachProposal): void {
  for (const value of [p.boxId, p.agentId, p.sessionId, p.eventsPath]) {
    if (typeof value !== "string" || value.trim() === "" || value.length > 4096) throw new Error("Invalid teaching identity");
  }
  if (p.display !== undefined && !isDisplayIndex(p.display)) throw new Error("Invalid teaching display");
  if (p.epoch !== undefined && (!Number.isSafeInteger(p.epoch) || p.epoch < 0)) throw new Error("Invalid teaching epoch");
  if (p.taskId !== undefined && (typeof p.taskId !== "string" || !p.taskId.trim() || p.taskId.length > 256)) throw new Error("Invalid teaching task");
  if (p.videoPath !== undefined && typeof p.videoPath !== "string") throw new Error("Invalid teaching video");
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
    if (Object.keys(parsed.meta).some(key => !["name", "description", "scope"].includes(key))) throw new Error("Teaching drafts cannot install a schedule, listener or other execution metadata");
  }
}

/** The real box publication path, shared by the host and filesystem integration tests. */
export async function publishTeachingSkill(box: Pick<BoxClient, "writeFile" | "uploadFile" | "readFile" | "listDir">, path: string, content: string): Promise<void> {
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
export class TeachDrafts {
  private readonly publishing = new Map<string, Promise<TeachDraft>>();
  constructor(private readonly root: string) {}

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
    generate: (draft: TeachDraft, answer: string) => Promise<Pick<TeachProposal, "skill" | "question">>): Promise<TeachDraft> {
    const original = this.reviewedQuestion(id, digest);
    if (typeof answer !== "string" || !answer.trim() || answer.length > 4096 ||
        typeof actor !== "string" || !actor.trim() || actor.length > 256) throw new Error("Provide a bounded clarification and its operator");
    if ((original.clarifications?.length ?? 0) >= 10) throw new Error("This demonstration has too many clarification rounds; record a new demonstration");
    const response = await generate(original, answer.trim());
    // Reject, another answer, or publication while the model was running wins.
    const current = this.reviewedQuestion(id, digest);
    const revised: TeachDraft = { ...current, skill: response.skill, question: response.question,
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
      // A unique destination avoids replacing an unrelated, already published recipe.
      await publish(draft.boxId, `${SKILLS_DIR}/taught-${draft.id}/SKILL.md`, draft.skill!);
      draft.status = "published";
      this.save(draft);
      return draft;
    })();
    this.publishing.set(id, pending);
    try { return await pending; } finally { this.publishing.delete(id); }
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
