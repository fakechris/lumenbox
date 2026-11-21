/**
 * Candidate evaluation cases from what really happened (INV-820): `agentbox eval candidates`.
 *
 * The answer review (answer-review.ts) judges replies as they go out and keeps the verdict with
 * hashes of the request and the reply, never the words. The corpus (evals/corpus.ts) is made of
 * cases somebody wrote by hand. This joins the two, on the operator's own machine and only when
 * the command is run: for every verdict in a time range that is not PASS it walks back, by the
 * message id, to the turn that message opened, takes what the person asked and what the agent
 * finally said, puts both through the audit export's scrubbing (audit-export.ts `redactLine`,
 * with the values the config and the vault hold) and writes one line per case to a local file.
 *
 * Nothing here enters the corpus, the golden tasks or the scenarios. A line is a corpus task with
 * its `gold` left empty and a `candidate` block beside it, so the loader's own check
 * (`taskProblem`) refuses it for that one reason until a person has said what a right answer
 * looks like — docs/100 says how. And nothing here asks a model anything.
 *
 * Only what a person asked is a request. Who opened a turn is `openingProvenance`'s call
 * (request-provenance.ts): a routine's prompt, an audit or a cue has a reply the review may have
 * judged, and is counted and left out; so is a turn nothing shows a person sent.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HeardRecord } from "../agents/heard-record.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { Messages, messagesPath } from "../channels/messages.ts";
import { type EvalTask, taskProblem } from "../evals/corpus.ts";
import type { AnswerReviewRecord } from "./answer-review.ts";
import { heldValues, redactLine } from "./audit-export.ts";
import { archivedLines } from "./jsonl.ts";
import { type IngressEvidence, type OpeningEntry, openingProvenance } from "./request-provenance.ts";

/** What a candidate carries beside the task it may become. Removed when it is confirmed. */
export interface CandidateDetail {
  /** What the agent finally said in that turn, scrubbed. */
  actual: string;
  review: { category: string; confidence: number; reason: string; at: string; mode: string };
  agent: string;
  agentId: string;
  conversation: string;
  /** The context version of the conversation the turn is in. */
  epoch: number;
  messageId: string;
  turnId?: string;
  /** The code and the model that produced the turn, as the turn ledger recorded them. */
  build?: { version: string; commit: string };
  model?: string;
  /** What shows a person sent it: the door's ledger, or the record of what the agent heard. */
  evidence: "door" | "heard";
  /** Whether the words found are the ones the review hashed. False is not an error: say, a reply the channel trimmed. */
  sameAsReviewed: { input: boolean; actual: boolean };
}

/** A corpus task whose `gold` nobody has written yet, and what it was made from. */
export type Candidate = Omit<EvalTask, "gold" | "input"> & { input: { says: string }; gold: EvalTask["gold"]; candidate: CandidateDetail };

/** Why a record that is not PASS, in the range and the box, did not become a candidate. */
const LEFT_OUT = {
  undecided: "the review could not decide (UNKNOWN)",
  unavailable: "the reviewer was unavailable",
  duplicate: "judged twice (the same message)",
  host: "opened by the host (a routine, an audit, a cue), not asked by a person",
  unverified: "stamped as a person's with no door or heard record to show it",
  missing: "no longer in a transcript",
  undated: "had no readable time",
} as const;

export interface CandidateRun {
  from: string;
  to: string;
  /** Records in the range (and the box, when one was named), PASS included. */
  considered: number;
  candidates: Candidate[];
  skipped: Record<keyof typeof LEFT_OUT | "pass", number>;
  /** The records whose words could not be found, so a person can tell a lost turn from a lost agent. */
  missing: { messageId: string; agent: string; at: string; why: string }[];
  redactions: { exact: number; pattern: number };
}

export interface CandidateOptions {
  /** ~/.agentbox, where the ledgers are. */
  home: string;
  registry: AgentRegistry;
  /** ISO instants, inclusive. */
  from: string;
  to: string;
  /** One box, by id or by name; every box when absent. */
  box?: string;
  /** Values that must not appear in a candidate, by name (audit-export.ts `heldValues`). */
  held?: ReadonlyMap<string, string>;
  evidence?: IngressEvidence;
}

type Entry = OpeningEntry & { kind?: string; text?: string; role?: string };
interface Located { conversation: string; epoch: number; entries: Entry[]; index: number }

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const slug = (text: string, max: number): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "x";

function jsonLines(path: string): Record<string, unknown>[] {
  const live = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  return [...archivedLines(path), ...live].flatMap(line => {
    if (line.trim() === "") return [];
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } // a torn last line is not a record
  });
}

/** Every message id an agent's turns cite, with where the turn it opened is. All context versions: a switched conversation keeps its past. */
function turnsByMessage(registry: AgentRegistry, agentId: string): Map<string, Located> {
  const found = new Map<string, Located>();
  for (const { id: conversation } of registry.listConversations(agentId)) {
    for (const { epoch, entries } of registry.readContextTranscriptsByEpoch(agentId, conversation)) {
      (entries as Entry[]).forEach((entry, index) => {
        for (const id of entry?.causedBy ?? []) if (!found.has(id)) found.set(id, { conversation, epoch, entries: entries as Entry[], index });
      });
    }
  }
  return found;
}

/** The last thing the agent said in the turn that starts at `index`: its words up to the next turn's opening. */
function replyOf({ entries, index }: Located): string | undefined {
  let reply: string | undefined;
  for (const entry of entries.slice(index + 1)) {
    if (entry.kind !== undefined || typeof entry.text !== "string") continue;
    if (entry.role === "user" && Array.isArray(entry.causedBy)) break;
    if (entry.role === "assistant" && entry.text.trim() !== "") reply = entry.text;
  }
  return reply;
}

export function collectCandidates(options: CandidateOptions): CandidateRun {
  const { registry, home } = options;
  const from = Date.parse(options.from), to = Date.parse(options.to);
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw new Error(`the range ${options.from} .. ${options.to} is not two instants in order`);
  const box = options.box === undefined ? undefined : registry.listBoxes().find(entry => entry.id === options.box || entry.name === options.box);
  if (options.box !== undefined && box === undefined) {
    throw new Error(`no box ${options.box}; known: ${registry.listBoxes().map(entry => `${entry.name} (${entry.id})`).join(", ") || "none"}`);
  }
  const agents = box === undefined ? registry.list() : registry.agentsIn(box.id);
  // The review writes the agent by name; an older line may carry the id.
  const agentOf = (named: unknown) => agents.find(agent => agent.profile.name === named || agent.id === named);
  const evidence = options.evidence ?? ingressEvidence(home);
  const held = options.held ?? new Map<string, string>();

  const began = new Map<string, { model?: string; build?: { version: string; commit: string } }>();
  for (const row of jsonLines(join(home, "turns.jsonl"))) {
    if (row.event === "begin" && typeof row.id === "string") began.set(row.id, { ...(typeof row.model === "string" ? { model: row.model } : {}), ...(isBuild(row.build) ? { build: row.build } : {}) });
  }

  const run: CandidateRun = {
    from: options.from, to: options.to, considered: 0, candidates: [], missing: [], redactions: { exact: 0, pattern: 0 },
    skipped: { pass: 0, undecided: 0, unavailable: 0, duplicate: 0, host: 0, unverified: 0, missing: 0, undated: 0 },
  };
  const scrub = (text: string): string => {
    const redacted = redactLine(text, held);
    run.redactions.exact += redacted.exact;
    run.redactions.pattern += redacted.pattern;
    return redacted.text;
  };
  const turns = new Map<string, Map<string, Located>>();
  const seen = new Set<string>();
  const ids = new Set<string>();

  for (const row of jsonLines(join(home, "answer-review.jsonl"))) {
    const record = row as Partial<AnswerReviewRecord>;
    if (typeof record.messageId !== "string" || typeof record.category !== "string") continue;
    // Whose it is comes first: with a box named, a record of another box's agent — or of an agent that no longer
    // exists, which is no box's — is not this run's to count.
    const agent = agentOf(record.agent);
    if (agent === undefined && box !== undefined) continue;
    const at = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
    if (Number.isNaN(at)) { run.skipped.undated += 1; continue; }
    if (at < from || at > to) continue;
    run.considered += 1;
    if (record.unavailable === true) { run.skipped.unavailable += 1; continue; }
    if (record.category === "PASS") { run.skipped.pass += 1; continue; }
    if (record.category === "UNKNOWN") { run.skipped.undecided += 1; continue; }
    const key = `${String(record.agent)}\n${record.messageId}`;
    if (seen.has(key)) { run.skipped.duplicate += 1; continue; }
    seen.add(key);
    const gone = (why: string): void => {
      run.skipped.missing += 1;
      run.missing.push({ messageId: record.messageId!, agent: String(record.agent), at: record.at!, why });
    };
    if (agent === undefined) { gone("the agent is no longer registered"); continue; }
    if (!turns.has(agent.id)) turns.set(agent.id, turnsByMessage(registry, agent.id));
    const located = turns.get(agent.id)!.get(record.messageId);
    if (located === undefined) { gone("no turn in the agent's transcripts cites this message"); continue; }
    const provenance = openingProvenance(agent.id, located.entries[located.index]!, evidence);
    if (provenance.by === "host") { run.skipped.host += 1; continue; }
    if (provenance.by === "unknown") { run.skipped.unverified += 1; continue; }
    // The message as the door kept it is what the review was shown; the turn's text may join several.
    const asked = evidence.door(record.messageId)?.text ?? provenance.text;
    const reply = replyOf(located);
    if (reply === undefined) { gone("the turn has no reply in the transcript"); continue; }
    if (asked.trim() === "") { gone("the request is empty in the record"); continue; }

    const turnId = located.entries[located.index]!.turnId;
    const stamp = turnId === undefined ? undefined : began.get(turnId);
    let id = `review.${slug(agent.profile.name, 30)}.${record.at!.slice(0, 10)}.${slug(record.messageId, 60)}`;
    if (ids.has(id)) id = `${id}.${sha256(key).slice(0, 8)}`;
    ids.add(id);
    const candidate: Candidate = {
      id,
      subject: "episode",
      source: { kind: "review-ledger", ref: `answer-review.jsonl#${record.messageId}` },
      failureType: record.category.toLowerCase().replace(/_/g, "-"),
      input: { says: scrub(asked) },
      gold: {},
      candidate: {
        actual: scrub(reply),
        review: {
          category: record.category, confidence: typeof record.confidence === "number" ? record.confidence : 0,
          reason: scrub(typeof record.reason === "string" ? record.reason : ""), at: record.at!, mode: String(record.mode ?? ""),
        },
        agent: agent.profile.name, agentId: agent.id, conversation: located.conversation, epoch: located.epoch, messageId: record.messageId,
        ...(turnId !== undefined ? { turnId } : {}),
        ...(stamp?.build !== undefined ? { build: stamp.build } : {}),
        ...(stamp?.model !== undefined ? { model: stamp.model } : {}),
        evidence: provenance.evidence,
        sameAsReviewed: { input: sha256(asked) === record.requestHash, actual: sha256(reply) === record.answerHash },
      },
    };
    // The promise the file makes, held here rather than described: only the gold is missing.
    confirmedTask({ ...candidate, gold: { format: "nonempty" } });
    run.candidates.push(candidate);
  }
  return run;
}

/**
 * What a person asked and what the agent finally said for one reviewed message, found the way the
 * candidates are found — for the labelling page (INV-1773, judge-sheet.ts), which scrubs it as these are.
 * Undefined when the turn is gone, was not a person's, or has no reply. Reads only what the
 * transcripts and the door's ledger already keep; the review's own line stays hashes.
 */
export function judgedExchange(home: string, registry: AgentRegistry, agentName: string, messageId: string, evidence: IngressEvidence = ingressEvidence(home)): { request: string; reply: string; agentId: string } | undefined {
  const agent = registry.list().find(one => one.profile.name === agentName || one.id === agentName);
  if (agent === undefined) return undefined;
  const located = turnsByMessage(registry, agent.id).get(messageId);
  if (located === undefined) return undefined;
  const provenance = openingProvenance(agent.id, located.entries[located.index]!, evidence);
  if (provenance.by !== "person") return undefined;
  const request = evidence.door(messageId)?.text ?? provenance.text;
  const reply = replyOf(located);
  if (reply === undefined || request.trim() === "") return undefined;
  return { request, reply, agentId: agent.id };
}

const isBuild = (value: unknown): value is { version: string; commit: string } =>
  typeof value === "object" && value !== null && typeof (value as { version?: unknown }).version === "string" && typeof (value as { commit?: unknown }).commit === "string";

/** The two ingress records of an installation, read from its files. */
function ingressEvidence(home: string): IngressEvidence {
  const doors = new Map(new Messages(messagesPath(home)).list().map(row => [row.id, row]));
  const heard = new HeardRecord(join(home, "heard"));
  return { door: id => doors.get(id), heard: (agentId, id) => heard.get(agentId, id) };
}

/**
 * The corpus task a candidate becomes once a person has written its `gold`: the same line without
 * the `candidate` block, checked by the corpus loader's own rule. Throws with the loader's words.
 */
export function confirmedTask(candidate: Candidate): EvalTask {
  const { candidate: _made, ...task } = candidate;
  const problem = taskProblem(task);
  if (problem !== undefined) throw new Error(`${candidate.id}: ${problem}`);
  return task as EvalTask;
}

/** The directory holding `.git` above a path, when the path is inside a checkout. */
export function workTreeOf(path: string): string | undefined {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

function refuseWorkTree(out: string, options: { inRepo?: boolean }): void {
  const tree = workTreeOf(dirname(resolve(out)));
  if (tree === undefined || options.inRepo === true) return;
  throw new Error(`${out} is inside a git work tree (${tree}): candidates hold what people said and are not for committing. Choose a path outside it, or pass --in-repo to write there anyway.`);
}

/** Writes the candidates, one a line, readable by the operator alone. Refuses a checkout unless told: a candidate is a person's words. */
export function writeCandidates(run: CandidateRun, out: string, options: { inRepo?: boolean } = {}): void {
  refuseWorkTree(out, options);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, run.candidates.map(one => `${JSON.stringify(one)}\n`).join(""), { mode: 0o600 });
  chmodSync(out, 0o600); // an existing file keeps its old mode through writeFileSync
}

/** The report, for the terminal. */
export function describeCandidates(run: CandidateRun, out: string): string[] {
  const lines = [
    `${run.candidates.length} candidate case(s) from ${run.considered} review record(s), ${run.from} .. ${run.to}`,
    `  ${out}`,
    `  left out: ${run.skipped.pass} judged PASS`,
  ];
  for (const [why, text] of Object.entries(LEFT_OUT)) {
    const count = run.skipped[why as keyof typeof LEFT_OUT];
    if (count > 0) lines.push(`  left out: ${count} ${text}`);
  }
  for (const one of run.missing) lines.push(`    missing: ${one.messageId} (${one.agent}, ${one.at}) — ${one.why}`);
  lines.push(`  redacted: ${run.redactions.exact} held value(s), ${run.redactions.pattern} credential-shaped string(s)`);
  lines.push("  Only held values and credential shapes are removed. Read each case before using it: names, addresses and the like are still there.");
  lines.push("  Nothing was added to the corpus. To confirm a case: write its `gold`, delete its `candidate` block, append the line to evals/corpus/dev.jsonl or test.jsonl (docs/100).");
  return lines;
}

const USAGE = [
  "usage: agentbox eval candidates [--from <iso>] [--to <iso>] [--box <id|name>] [--out <file>] [--in-repo]",
  "  Replies the answer review judged not PASS, with what was asked and what was answered, as candidate",
  "  evaluation cases in a local file. The last 30 days unless a range is given. Makes no model call and",
  "  adds nothing to the corpus. Refuses to write inside a git work tree without --in-repo.",
].join("\n");

export async function cmdEval(args: string[], io: { home: string; out: (line: string) => void; err: (line: string) => void }): Promise<number> {
  if (args[0] !== "candidates") {
    io.err(USAGE);
    return 2;
  }
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 1) {
    const key = args[i]!;
    if (key === "--in-repo") { flags.set("in-repo", "yes"); continue; }
    const value = args[i + 1];
    if (!["--from", "--to", "--box", "--out"].includes(key) || value === undefined) {
      io.err(`eval candidates: ${key} ${value === undefined && key.startsWith("--") ? "needs a value" : "is not an option"}\n${USAGE}`);
      return 2;
    }
    flags.set(key.slice(2), value);
    i += 1;
  }
  const now = new Date();
  const from = flags.get("from") ?? new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const to = flags.get("to") ?? now.toISOString();
  const box = flags.get("box");
  const out = flags.get("out") ?? join(io.home, "exports", `eval-candidates-${from.slice(0, 10)}-${to.slice(0, 10)}.jsonl`);
  try {
    refuseWorkTree(out, { inRepo: flags.has("in-repo") }); // before a conversation is read, not after
    const run = collectCandidates({ home: io.home, registry: new AgentRegistry(join(io.home, "agents")), from, to, ...(box !== undefined ? { box } : {}), held: heldValues(io.home) });
    writeCandidates(run, out, { inRepo: flags.has("in-repo") });
    for (const line of describeCandidates(run, out)) io.out(line);
    return 0;
  } catch (error) {
    io.err(`eval candidates: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
