/**
 * "Forget X", done completely and said honestly (INV-757).
 *
 * Source withdrawal (9546aba) retires memory that came from one message. A person saying "forget my
 * test results" means the words, wherever they went: memory in both tiers, the box's mirror of it,
 * pages and tool results kept on disk, the board, the commitments ledger — and the routine that would
 * write it all back next Monday. So:
 *
 * 1. **Plan** — read-only. Every place is searched for the phrase; the answer is counts per place,
 *    never the text. The plan is held in memory only: a stored plan would be a stored copy of what
 *    is to be forgotten.
 * 2. **One confirmation** — a later turn, after the person has spoken. The same turn cannot confirm
 *    its own plan; an agent cannot talk itself into deleting.
 * 3. **Execute** — searched again from scratch (what appeared since the plan is found too), then
 *    producers first: a routine whose text holds the phrase is paused before anything it makes is
 *    cleaned, so it cannot write the phrase back. Then the copies. Then searched a third time, and
 *    "forgotten" is said only for what that last search found gone.
 *
 * Kept, by decision and said so: raw transcripts, the message log and audit logs (docs/handoff-
 * 2026-09-24-memory-provenance.md: withdrawing never deletes the record of what was said), and
 * skills that merely mention the phrase, which are the person's to edit. The report counts these
 * without quoting them.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRegistry } from "../agents/registry.ts";
import type { BoxClient } from "../box/client.ts";
import type { TaskStore } from "./tasks.ts";
import { fetchedDir } from "./fetched.ts";
import { resultsDir } from "./results.ts";
import { loadSkills } from "./skills.ts";
import { rewriteFrontmatter } from "./template.ts";
import { MEMORY_MIRROR_DIR, renderMemoryFiles } from "./memory.ts";

export interface ForgetStores {
  registry: AgentRegistry;
  tasks?: TaskStore;
  box?: Pick<BoxClient, "listDir" | "readFile" | "writeFile">;
  /** The installation home: where fetched pages, kept results and the ledgers live. */
  home: string;
}

/** Where the phrase is, as counts and names — never the phrase or the text around it. */
export interface ForgetInventory {
  memory: number;
  sharedMemory: number;
  memoryMirror: number;
  fetchedPages: number;
  keptResults: number;
  tasks: number;
  commitments: number;
  /** Routines — scheduled, listening, webhook — whose text holds it: the producers. */
  routines: string[];
  /** Other skills that mention it: not ours to rewrite. */
  skills: string[];
  /** Kept by decision: counted, never cleaned. */
  kept: { transcripts: number; messages: number; auditLines: number };
}

/** Too short to mean one thing: "a" would forget half the installation. */
const MIN_PHRASE = 2;

export function forgettable(phrase: string): string | undefined {
  const trimmed = phrase.trim();
  if (trimmed.length < MIN_PHRASE) return "That is too short to forget safely — give the words that were said.";
  if (trimmed.length > 200) return "Give the words to forget, not a paragraph: a short phrase that appears wherever it was kept.";
  return undefined;
}

export async function inventory(phrase: string, stores: ForgetStores): Promise<ForgetInventory> {
  const needle = phrase.toLowerCase();
  const holds = (text: string) => text.toLowerCase().includes(needle);
  const agents = stores.registry.list();
  let memory = 0;
  let sharedMemory = 0;
  let transcripts = 0;
  for (const agent of agents) {
    memory += linesMentioning(stores.registry.memoryRecordsPathFor(agent.id), needle);
    sharedMemory += linesMentioning(stores.registry.sharedMemoryPathFor(agent.id), needle);
    for (const conversation of new Set(["main", ...stores.registry.listConversations(agent.id).map(item => item.id)])) {
      transcripts += stores.registry.readAllContextTranscripts(agent.id, conversation).filter(entry => holds(JSON.stringify(entry))).length;
    }
  }
  const { routines, skills } = await skillsMentioning(stores.box, needle);
  return {
    memory,
    sharedMemory,
    memoryMirror: (await mirrorFilesMentioning(stores.box, needle)).length,
    fetchedPages: filesMentioning(fetchedDir(stores.home), needle).length,
    keptResults: filesMentioning(resultsDir(stores.home), needle).length,
    tasks: stores.tasks?.mentioning(phrase) ?? 0,
    commitments: linesMentioning(join(stores.home, "commitments.jsonl"), needle),
    routines,
    skills,
    kept: {
      transcripts,
      messages: linesMentioning(join(stores.home, "messages.jsonl"), needle),
      auditLines: linesMentioning(join(stores.home, "memory-audit.jsonl"), needle),
    },
  };
}

export interface ForgetOutcome {
  /** What was done, by place. */
  done: { memory: number; sharedMemory: number; memoryMirror: number; fetchedPages: number; keptResults: number; tasks: number; taskHistory: boolean; commitments: number; routinesPaused: string[] };
  /** The fresh search afterwards: anything non-zero here in a cleanable place was not forgotten. */
  after: ForgetInventory;
}

/** Producers first, then copies, then a fresh look. */
export async function executeForget(phrase: string, stores: ForgetStores): Promise<ForgetOutcome> {
  const needle = phrase.toLowerCase();
  // 1. The producers: a routine that would write it back is paused before anything is cleaned.
  const { routinePaths } = await skillsMentioning(stores.box, needle);
  const routinesPaused: string[] = [];
  for (const { slug, path } of routinePaths) {
    const read = await stores.box!.readFile(path);
    await stores.box!.writeFile(path, rewriteFrontmatter(read.content, { set: { paused: "true" }, add: { paused: "true" } }));
    routinesPaused.push(slug);
  }
  // 2. The copies.
  const memory = stores.registry.forgetMemoryMentioning(phrase);
  const memoryMirror = await refreshMirrors(stores, needle, memory.agents);
  const fetchedPages = deleteAll(filesMentioning(fetchedDir(stores.home), needle));
  const keptResults = deleteAll(filesMentioning(resultsDir(stores.home), needle));
  // Whether the board's history held it, asked before the rewrite: a task renamed since keeps the
  // old wording only in an earlier snapshot, and that rewrite is worth saying.
  const taskHistory = stores.tasks?.fileMentions(phrase) ?? false;
  const tasks = stores.tasks?.scrub(phrase) ?? 0;
  const commitments = scrubLines(join(stores.home, "commitments.jsonl"), phrase);
  // 3. A fresh look, so "forgotten" is a finding, not an intention.
  const after = await inventory(phrase, stores);
  return {
    done: { memory: memory.personal, sharedMemory: memory.shared, memoryMirror, fetchedPages, keptResults, tasks, taskHistory, commitments, routinesPaused },
    after,
  };
}

/**
 * What the agent tells the person, in counts and names. Never the phrase: a report that repeats
 * what was forgotten has put it back in the conversation.
 */
export function forgetPlanReport(found: ForgetInventory, planId: string): string {
  const places = cleanablePlaces(found);
  if (places.length === 0 && found.routines.length === 0) {
    return `Nothing to forget: it is not in memory, kept pages, kept results, the board or any routine. ${keptLine(found)}`.trim();
  }
  return (
    `Plan ${planId} — nothing has been changed yet.\n` +
    (found.routines.length > 0 ? `First, pause ${found.routines.length} routine(s) that would write it back: ${found.routines.join(", ")}.\n` : "") +
    (places.length > 0 ? `Then remove it from: ${places.join("; ")}.\n` : "") +
    (found.skills.length > 0 ? `Skills that mention it and stay as they are (the person's to edit): ${found.skills.join(", ")}.\n` : "") +
    `${keptLine(found)}\n` +
    `Tell the person this in their words, without repeating what is to be forgotten, and ask once for a clear yes. ` +
    `Only after they answer, in a later turn, call Forget with action "confirm" and this plan id. Forgetting cannot be undone.`
  );
}

export function forgetOutcomeReport(outcome: ForgetOutcome): string {
  const d = outcome.done;
  const done = [
    d.routinesPaused.length > 0 ? `paused ${d.routinesPaused.length} routine(s) first (${d.routinesPaused.join(", ")})` : "",
    d.memory + d.sharedMemory > 0 ? `${d.memory + d.sharedMemory} memory line(s)` : "",
    d.memoryMirror > 0 ? `${d.memoryMirror} memory mirror file(s) in the box` : "",
    d.fetchedPages > 0 ? `${d.fetchedPages} kept page(s)` : "",
    d.keptResults > 0 ? `${d.keptResults} kept tool result(s)` : "",
    d.tasks > 0 ? `${d.tasks} task(s), history included` : d.taskHistory ? "earlier wording in the board's task history" : "",
    d.commitments > 0 ? `${d.commitments} commitment line(s)` : "",
  ].filter(line => line !== "");
  const left = cleanablePlaces(outcome.after);
  return (
    (done.length > 0 ? `Removed: ${done.join("; ")}.` : "Nothing needed removing.") +
    (left.length === 0
      ? " Checked again afterwards: none of those places holds it now."
      : ` Checked again afterwards and it is STILL in: ${left.join("; ")} — do not say it is forgotten; say what is left.`) +
    (outcome.after.skills.length > 0 ? ` Skills that still mention it, for the person to edit: ${outcome.after.skills.join(", ")}.` : "") +
    ` ${keptLine(outcome.after)} Tell the person what was removed and what is kept, in counts — never the words themselves.`
  );
}

function cleanablePlaces(found: ForgetInventory): string[] {
  return [
    found.memory + found.sharedMemory > 0 ? `${found.memory + found.sharedMemory} memory line(s)` : "",
    found.memoryMirror > 0 ? `${found.memoryMirror} memory mirror file(s)` : "",
    found.fetchedPages > 0 ? `${found.fetchedPages} kept page(s)` : "",
    found.keptResults > 0 ? `${found.keptResults} kept tool result(s)` : "",
    found.tasks > 0 ? `${found.tasks} task(s)` : "",
    found.commitments > 0 ? `${found.commitments} commitment line(s)` : "",
  ].filter(line => line !== "");
}

function keptLine(found: ForgetInventory): string {
  const { transcripts, messages, auditLines } = found.kept;
  if (transcripts + messages + auditLines === 0) return "";
  return (
    `Kept by design and not removed: the record of what was said — ${transcripts} transcript entr${transcripts === 1 ? "y" : "ies"}, ` +
    `${messages} logged message(s), ${auditLines} audit line(s). Withdrawing never deletes that record.`
  );
}

// ── the stores ──────────────────────────────────────────────────────────────────────────────

function linesMentioning(path: string, needle: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(line => line.toLowerCase().includes(needle)).length;
}

function filesMentioning(root: string, needle: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (readFileSync(full, "utf8").toLowerCase().includes(needle)) found.push(full);
    }
  };
  walk(root);
  return found;
}

function deleteAll(paths: readonly string[]): number {
  for (const path of paths) unlinkSync(path);
  return paths.length;
}

/** A host ledger's lines with the phrase replaced, rewritten atomically. */
function scrubLines(path: string, phrase: string): number {
  if (!existsSync(path)) return 0;
  const pattern = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const lines = readFileSync(path, "utf8").split("\n");
  let changed = 0;
  const next = lines.map(line => {
    if (!pattern.test(line)) return line;
    pattern.lastIndex = 0;
    changed += 1;
    return line.replace(pattern, "[forgotten]");
  });
  if (changed === 0) return 0;
  const temp = `${path}.${process.pid}.forget.tmp`;
  writeFileSync(temp, next.join("\n"), "utf8");
  renameSync(temp, path);
  return changed;
}

async function skillsMentioning(
  box: ForgetStores["box"],
  needle: string
): Promise<{ routines: string[]; skills: string[]; routinePaths: { slug: string; path: string }[] }> {
  if (box === undefined) return { routines: [], skills: [], routinePaths: [] };
  const loaded = await loadSkills(box as BoxClient).catch(() => ({ skills: [] as Awaited<ReturnType<typeof loadSkills>>["skills"] }));
  const routinePaths: { slug: string; path: string }[] = [];
  const skills: string[] = [];
  for (const skill of loaded.skills) {
    const text = await box.readFile(skill.path).then(read => read.content).catch(() => "");
    if (!text.toLowerCase().includes(needle)) continue;
    const unattended = skill.schedule !== undefined || skill.listener !== undefined || skill.webhook === true;
    // An already-paused routine produces nothing; it is a skill that mentions it.
    if (unattended && skill.paused !== true) routinePaths.push({ slug: skill.slug, path: skill.path });
    else skills.push(skill.slug);
  }
  return { routines: routinePaths.map(entry => entry.slug), skills, routinePaths };
}

async function mirrorFilesMentioning(box: ForgetStores["box"], needle: string): Promise<string[]> {
  if (box === undefined) return [];
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await box.listDir(dir).then(list => list.entries).catch(() => []);
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.type === "directory") await walk(path);
      else if ((await box.readFile(path).then(read => read.content).catch(() => "")).toLowerCase().includes(needle)) found.push(path);
    }
  };
  await walk(MEMORY_MIRROR_DIR);
  return found;
}

/** Re-renders the box mirror of each agent whose memory changed; a stale file that still holds it is emptied. */
async function refreshMirrors(stores: ForgetStores, needle: string, agentIds: readonly string[]): Promise<number> {
  if (stores.box === undefined) return 0;
  let written = 0;
  for (const agentId of agentIds) {
    const agent = stores.registry.tryGet(agentId);
    if (agent === undefined) continue;
    for (const file of renderMemoryFiles(agent.profile.name, stores.registry.readMemoryRecords(agentId))) {
      await stores.box.writeFile(file.path, file.content);
      written += 1;
    }

  }
  for (const stale of await mirrorFilesMentioning(stores.box, needle)) {
    await stores.box.writeFile(stale, "");
    written += 1;
  }
  return written;
}

// ── the plan between the two turns ───────────────────────────────────────────────────────────

interface HeldPlan {
  phrase: string;
  agentId: string;
  conversation: string;
  turnId: string | undefined;
  at: number;
}

/**
 * Plans between the asking turn and the confirming one. In memory and short-lived on purpose: a
 * plan holds the phrase, and a durable copy of what someone asked to forget is the one thing this
 * must not leave behind. A restart loses the plan; the person is asked again, which is correct.
 */
export class ForgetPlans {
  private readonly plans = new Map<string, HeldPlan>();
  constructor(private readonly ttlMs = 60 * 60_000, private readonly now = () => Date.now()) {}

  hold(plan: Omit<HeldPlan, "at">): string {
    this.sweep();
    const id = `forget-${randomUUID().slice(0, 8)}`;
    this.plans.set(id, { ...plan, at: this.now() });
    return id;
  }

  /**
   * The phrase for a confirm, or why not. Refused in the turn that made the plan, and until the
   * person has said something since — a confirmation is theirs, not the agent's.
   */
  take(id: string, request: { agentId: string; conversation: string; turnId: string | undefined; personSpokeSince: (at: number) => boolean }): { phrase: string } | { refused: string } {
    this.sweep();
    const plan = this.plans.get(id);
    if (plan === undefined) return { refused: "No such plan, or it expired. Make a new plan with action \"plan\" and ask the person again." };
    if (plan.agentId !== request.agentId || plan.conversation !== request.conversation) return { refused: "That plan belongs to another conversation." };
    if (plan.turnId !== undefined && plan.turnId === request.turnId) {
      return { refused: "A plan cannot be confirmed in the turn that made it. Tell the person what it would remove, ask for a clear yes, and end your turn." };
    }
    if (!request.personSpokeSince(plan.at)) return { refused: "The person has not answered since the plan was made. Ask them, and confirm only after they say yes." };
    this.plans.delete(id);
    return { phrase: plan.phrase };
  }

  private sweep(): void {
    for (const [id, plan] of this.plans) if (this.now() - plan.at > this.ttlMs) this.plans.delete(id);
  }
}
