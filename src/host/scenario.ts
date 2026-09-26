/**
 * Episodes, so a complaint becomes a test.
 *
 * Every conduct problem in this system arrived the same way: the person ran a real task, watched
 * a team make a mess of it, and told us. The mess is never in one function — it is a shape across
 * a whole episode (five questions before any work, two agents apologising at each other, a turn
 * that polls for a file that never lands). A unit test cannot see a shape like that, so the shapes
 * kept coming back.
 *
 * An episode here is the real stack — registry, bus, `runTurn`, the real tools and prompts — with
 * two things faked: the model (a script, so a run is deterministic) and the box (in memory, so
 * files can be asserted). What comes out is a **scorecard**: counts a person would recognise
 * (questions asked, messages between agents, tool calls before the first reply, work landed),
 * which is what the assertions are written against.
 *
 * The scripted model is not a model. It cannot tell us whether a real one behaves well — that is
 * what `scripts/scenario-live.mjs` is for, running the same scenarios against the real provider.
 * What it tests is the rails: given a model that behaves badly in a named way, does the harness
 * still hold the shape? Every scenario here is a real episode that went wrong.
 */

import type { Skill } from "./skills.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import { runTurn } from "./turn.ts";
import { fakeModel } from "./testing/fake-model.ts";
import type { BoxClient } from "../box/client.ts";
import type { HistoryEntry } from "./compaction.ts";
import { Rememberer, summariseExchange } from "./remember.ts";
import { memoryRef } from "./memory.ts";
import type { ProviderProfile } from "./provider.ts";
import type { PolicyGate } from "./policy.ts";
import type { McpManager } from "./mcp.ts";

/** One model reply, in the shape the script writes it. */
export type ScriptedReply =
  // `stop` replays a reply that ran to the output cap (INV-761); a say ends its turn otherwise.
  | { say: string; stop?: "max_tokens" }
  | { call: string; input: Record<string, unknown>; then?: ScriptedReply };

export interface ScriptContext {
  /** The agent this call is for. */
  agent: string;
  /** Its system prompt, so a script can assert on what the agent was told. */
  system: string;
  /** How many model calls this conversation has already made. */
  round: number;
  /** The text that opened this turn. */
  opened: string;
  /** Which tools were offered this call, by name. */
  offered: string[];
  /** The actual model-visible context, for replay/compaction regressions. */
  messages: Anthropic.MessageParam[];
}

/** What the script does at each model call. Returning undefined ends the turn silently. */
export type Script = (context: ScriptContext) => ScriptedReply | undefined | Promise<ScriptedReply | undefined>;

export interface Observation {
  at: number;
  agent: string;
  kind: "call" | "result" | "say" | "message" | "turn";
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  to?: string;
  isError?: boolean;
}

/**
 * What a person would count if they read the episode. Names chosen so a failing assertion reads
 * like the complaint it came from: "asked 5 questions before doing anything".
 */
export interface Scorecard {
  /** Model calls, over every agent and conversation. */
  rounds: number;
  /** Turns run. */
  turns: number;
  /** AskUser calls that were actually delivered. */
  questions: number;
  /** AskUser calls the tools refused (over budget, or withheld on a peer turn). */
  questionsRefused: number;
  /** Tool calls before this episode did anything the person asked for. */
  callsBeforeFirstAnswer: number;
  /** Messages between agents. */
  peerMessages: number;
  /** Agents in the roster at the end, by name. */
  agents: string[];
  /** Files the box holds at the end. */
  files: string[];
  /** Every call, in order, as "agent:Tool". */
  trail: string[];
  /** What each agent said to the person, in order. */
  said: { agent: string; text: string }[];
  /** Tool calls that came back as errors, as "agent:Tool — reason". */
  refusals: string[];
}

export interface EpisodeResult {
  score: Scorecard;
  observations: Observation[];
  registry: AgentRegistry;
  files: Map<string, string>;
  cleanup: () => void;
}

/** A box that keeps its files in a Map, so a scenario can assert on what landed. */
function memoryBox(files: Map<string, string>, overrides: Partial<BoxClient> = {}): BoxClient {
  const box = {
    ...overrides,
    exec: async (command: string) => {
      // Enough shell for a scenario: mkdir and echo-into-file are what agents actually reach for.
      const redirect = /^echo\s+"?(.*?)"?\s*>\s*(\S+)$/.exec(command.trim());
      if (redirect) {
        files.set(redirect[2]!, redirect[1]!);
        return { exit_code: 0, stdout: "", stderr: "" };
      }
      // Looking around is answered from the files (INV-693): a live model that runs `ls` and gets
      // "(ran) ls" back looks again, and spent a skill eval's whole budget doing so. Anything that
      // is not plain looking keeps the old answer, which scripted scenarios rely on.
      const looked = lookAround(files, command);
      if (looked !== undefined) return { exit_code: looked.exit, stdout: looked.stdout, stderr: "" };
      return { exit_code: 0, stdout: `(ran) ${command}`, stderr: "" };
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
      return { path, bytes: content.length };
    },
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`${path} does not exist`);
      return { path, content, total_lines: content.split("\n").length, truncated: false };
    },
    // What delivery reads: the file exactly, so the delivery gate checks what a person would get.
    downloadFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`${path} does not exist`);
      return { path, size: Buffer.byteLength(content), media_type: "application/octet-stream", base64: Buffer.from(content).toString("base64") };
    },
    listDir: async (path: string) => ({
      path,
      entries: [...files.keys()]
        .filter(name => name.startsWith(path))
        .map(name => ({ name: name.slice(path.length).replace(/^\//, ""), type: "file", size: 0 })),
    }),
  };
  return new Proxy(box, {
    get: (target, property) =>
      property in target ? target[property as keyof typeof target] : async () => ({}),
  }) as unknown as BoxClient;
}

/**
 * `ls`, `cat`, `head`, `tail`, `wc -l`, `find`, `file`, `pwd`, `date`, `echo`, `cd` and `git` (always "not a
 * repository"), chained with `&&` or `;`, answered from the memory box's
 * files. Undefined for anything else, including any segment it does not recognise, so a command
 * that would do something is never half-simulated.
 */
/** What `date` says in a memory box: fixed, so an episode reads the same every run. */
const EPISODE_DATE = "Fri Sep 26 09:00:00 UTC 2026";

function lookAround(files: Map<string, string>, command: string): { stdout: string; exit: number } | undefined {
  const home = "/home/box/work";
  const out: string[] = [];
  let exit = 0;
  // Split into segments, keeping the operator that joins each to the next, so `&&` stops after a
  // failure the way a shell does and `;` carries on.
  const parts = command.split(/(&&|;)/);
  for (let index = 0; index < parts.length; index += 2) {
    const joiner = index === 0 ? ";" : parts[index - 1]!;
    if (joiner === "&&" && exit !== 0) break;
    const segment = parts[index]!.split("|")[0]!.replace(/\s+2>(&1|\/dev\/null)/g, "").trim();
    if (segment === "") continue;
    const words = segment.split(/\s+/).map(word => word.replace(/^["']|["']$/g, "").replace(/^~/, "/home/box"));
    const [verb, ...rest] = words;
    const args = rest.filter(arg => !arg.startsWith("-"));
    const said = (text: string, code = 0) => { out.push(text); exit = code; };
    if (verb === "pwd") said(home);
    else if (verb === "date") said(EPISODE_DATE);
    else if (verb === "cd") exit = 0;
    else if (verb === "echo") said(rest.join(" "));
    // There is no repository in a memory box, and saying so — with git's own status — is the honest answer.
    else if (verb === "git") said("fatal: not a git repository (or any of the parent directories): .git", 128);
    else if (verb === "find") {
      const found = findIn(files, rest, home);
      if (typeof found === "string") said(found, 1);
      else said(found.join("\n"));
    } else if (verb === "file") {
      const missing = args.filter(path => !files.has(path));
      said(args.map(path => `${path}: ${files.has(path) ? "data" : "cannot open (No such file or directory)"}`).join("\n"), missing.length > 0 ? 1 : 0);
    } else if (verb === "head" || verb === "tail") {
      const count = lineCount(rest);
      const missing = args.filter(path => !files.has(path));
      said(
        args.map(path => {
          const content = files.get(path);
          if (content === undefined) return `${verb}: cannot open '${path}' for reading: No such file or directory`;
          const lines = content.replace(/\n$/, "").split("\n");
          return (verb === "head" ? lines.slice(0, count) : lines.slice(-count)).join("\n");
        }).join("\n"),
        missing.length > 0 ? 1 : 0
      );
    } else if (verb === "ls") {
      const dir = (args[0] ?? home).replace(/\/$/, "");
      if (files.has(dir)) { said(dir.split("/").pop()!); continue; }
      const children = [...new Set([...files.keys()].filter(path => path.startsWith(`${dir}/`)).map(path => path.slice(dir.length + 1).split("/")[0]!))];
      if (children.length > 0) said(children.sort().join("\n"));
      else said(`ls: cannot access '${dir}': No such file or directory`, 2);
    } else if (verb === "cat") {
      const missing = args.filter(path => !files.has(path));
      said(args.map(path => files.get(path) ?? `cat: ${path}: No such file or directory`).join("\n"), missing.length > 0 ? 1 : 0);
    } else if (verb === "wc") said(args.map(path => `${(files.get(path) ?? "").split("\n").length - 1} ${path}`).join("\n"));
    else return undefined;
  }
  return { stdout: out.join("\n"), exit };
}

/** `-n N`, `-nN` or `-N` for head and tail; ten lines, as the real ones default to. */
function lineCount(words: readonly string[]): number {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === "-n" && words[index + 1] !== undefined) return Math.max(0, Number(words[index + 1]) || 0);
    const joined = /^-n?(\d+)$/.exec(word);
    if (joined) return Number(joined[1]);
  }
  return 10;
}

/**
 * `find` over the memory box's files, honouring `-type f|d`, `-name` and `-maxdepth`. Any other
 * predicate is refused by name rather than ignored: an unfiltered list for `-mtime -1` would tell a
 * live model something false about the box. The memory box keeps no file times.
 */
function findIn(files: Map<string, string>, words: readonly string[], home: string): string[] | string {
  const root = (words[0] !== undefined && !words[0].startsWith("-") ? words[0] : home).replace(/\/$/, "");
  let type: "f" | "d" | undefined;
  let name: RegExp | undefined;
  let maxDepth = Number.POSITIVE_INFINITY;
  for (let index = words[0] === root ? 1 : 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === "-type") { const value = words[++index]; if (value !== "f" && value !== "d") return `find: -type ${value ?? ""} is not supported in this box`; type = value; }
    else if (word === "-name" || word === "-iname") {
      const glob = words[++index] ?? "*";
      name = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, word === "-iname" ? "i" : "");
    } else if (word === "-maxdepth") maxDepth = Number(words[++index] ?? "0");
    else if (word.startsWith("-")) return `find: ${word} is not supported in this box (it keeps no file times or owners)`;
  }
  const under = [...files.keys()].filter(path => path === root || path.startsWith(`${root}/`));
  const dirs = new Set<string>();
  for (const path of under) {
    let parent = path.slice(0, path.lastIndexOf("/"));
    while (parent.length > root.length) { dirs.add(parent); parent = parent.slice(0, parent.lastIndexOf("/")); }
  }
  const entries = [...(type === "d" ? [] : under.map(path => ({ path, kind: "f" as const }))), ...(type === "f" ? [] : [...dirs].map(path => ({ path, kind: "d" as const })))];
  return entries
    .filter(entry => entry.path.slice(root.length).split("/").length - 1 <= maxDepth)
    .filter(entry => name === undefined || name.test(entry.path.split("/").pop()!))
    .map(entry => entry.path)
    .sort();
}

function message(content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"]): Anthropic.Message {
  return {
    id: "msg_scenario",
    type: "message",
    role: "assistant",
    model: "scenario",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

export interface EpisodeOptions {
  /** The agents the episode starts with. The first is the one the person talks to. */
  team: { name: string; description?: string }[];
  /** What the person says, in order. Each is sent to the front agent and awaited. */
  says: string[];
  /** What the model does. Unused when `client` is given. */
  script?: Script;
  /**
   * A real model instead of the script (INV-693): the same stack, judged on what a model
   * actually chose. Used by the live skill evals, never by `npm test`.
   */
  client?: Anthropic;
  /** The provider the turn names in its requests; only meaningful with `client`. */
  provider?: ProviderProfile;
  /** A policy gate every tool call is checked against (INV-753); absent means allow, as before. */
  policy?: PolicyGate;
  /** Connected external tools, as the MCP manager offers them; absent means none. */
  mcp?: McpManager;
  /** Files the box starts with. */
  files?: Record<string, string>;
  /** Stops an episode that will not settle. Default 200. */
  maxRounds?: number;
  /**
   * Box operations a journey scripts (INV-480): a browser that answers with a fixed page,
   * say. Everything not given keeps the memory box's behaviour.
   */
  box?: Partial<BoxClient>;
  /** A desktop index, so browser tools are offered and reach the scripted box rather than refusing for want of a display. */
  display?: number;
  /** Skills the agents are offered, as the prompt would list them (INV-481). */
  skills?: readonly Skill[];
  /** Persisted history before the episode, including legacy compaction records. */
  history?: readonly HistoryEntry[];
  /** Script only the relevance decision, while retaining the production projection path. */
  selectMemory?: (prompt: string) => Promise<string | undefined>;
  /**
   * Wire the production memory path (INV-778): each person-driven turn is recorded for
   * batch extraction and a compaction flushes what it summarises, both through the
   * scripted model. Opt-in, because the extra model calls would surprise every script
   * that counts rounds.
   */
  memory?: boolean;
  /**
   * Drive concurrent channel arrivals through the real bus instead of sequential says.
   * `say` is one line of `says`, with the same after-turn bookkeeping, for a drive that
   * needs to change the world between turns.
   */
  drive?: (context: { bus: AgentBus; registry: AgentRegistry; frontId: string; files: Map<string, string>; say: (line: string) => Promise<void> }) => Promise<void>;
}

/**
 * Runs one episode to quiet and scores it.
 *
 * "To quiet" is the bus going idle: every queued message consumed, every turn finished. A
 * scenario that never settles hits `maxRounds` and the scorecard says so rather than hanging.
 */
export async function runEpisode(options: EpisodeOptions): Promise<EpisodeResult> {
  const home = mkdtempSync(join(tmpdir(), "agentbox-scenario-"));
  const registry = new AgentRegistry(home);
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const box = memoryBox(files, options.box ?? {});
  const observations: Observation[] = [];
  const rounds = new Map<string, number>();
  let clock = 0;
  let calls = 0;
  const maxRounds = options.maxRounds ?? 200;

  for (const member of options.team) {
    // The box is named rather than defaulted, the same rule the guard test holds every other
    // create site to: an episode's team lives in the episode's own box.
    registry.create({
      name: member.name,
      boxId: registry.box.id,
      ...(member.description !== undefined ? { description: member.description } : {}),
    });
  }
  const front = registry.list()[0]!;
  for (const entry of options.history ?? []) registry.appendTranscript(front.id, entry);

  // One responder for both wires: the turn loop streams, the summariser and the memory
  // extractor call `create` (INV-778). A script tells them apart by what opened the call.
  const respond = async ({ params }: { params: Anthropic.MessageCreateParams }) => {
    calls += 1;
    if (calls > maxRounds) return message([{ type: "text", text: "(scenario cut: too many rounds)" } as Anthropic.ContentBlock], "end_turn");
    const system =
      typeof params.system === "string"
        ? params.system
        : (params.system ?? []).map(block => ("text" in block ? block.text : "")).join("\n");
    // Which agent this is: the profile section names it, and the roster does not.
    // "Your name is X." is the one line that identifies whose turn this is (prompt.ts,
    // profileSection). Matched exactly rather than by any mention, since the roster names
    // every teammate in the same prompt.
    const named = /Your name is ([^.\n]+)\./.exec(system)?.[1]?.trim();
    const agent = named ?? "unknown";
    const key = `${agent}:${params.messages.length}`;
    const round = rounds.get(agent) ?? 0;
    rounds.set(agent, round + 1);
    void key;
    const first = params.messages[0];
    const opened = typeof first?.content === "string" ? first.content : "";
    const offered = (params.tools ?? []).map(tool => ("name" in tool ? String(tool.name) : ""));
    const reply = await options.script!({ agent, system, round, opened, offered, messages: params.messages });
    if (reply === undefined) return message([{ type: "text", text: "" } as Anthropic.ContentBlock], "end_turn");
    if ("say" in reply) {
      observations.push({ at: clock++, agent, kind: "say", text: reply.say });
      return message([{ type: "text", text: reply.say } as Anthropic.ContentBlock], reply.stop ?? "end_turn");
    }
    observations.push({ at: clock++, agent, kind: "call", name: reply.call, input: reply.input });
    return message(
      [{ type: "tool_use", id: `t${clock}`, name: reply.call, input: reply.input } as unknown as Anthropic.ContentBlock],
      "tool_use"
    );
  };
  const scripted = fakeModel(respond, { create: respond });
  if (options.client === undefined && options.script === undefined) throw new Error("runEpisode needs a script or a client");
  const client = options.client ?? scripted;

  const rememberer = options.memory === true
    ? new Rememberer({ registry, client, provider: { label: "scenario", model: "scenario", maxTokens: 1024 } as ProviderProfile })
    : undefined;
  const bus: AgentBus = new AgentBus(registry, async (record, inbound, signal, conversation) => {
    for (const inboundMessage of inbound) {
      if (inboundMessage.fromId !== "user") {
        observations.push({
          at: clock++,
          agent: registry.tryGet(inboundMessage.fromId)?.profile.name ?? inboundMessage.fromId,
          kind: "message",
          to: record.profile.name,
          text: inboundMessage.text,
        });
      }
    }
    observations.push({ at: clock++, agent: record.profile.name, kind: "turn", text: conversation });
    await runTurn(record, inbound, signal, {
      client,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      ...(options.mcp !== undefined ? { mcp: options.mcp } : {}),
      registry,
      bus,
      box,
      resolution: undefined,
      ...(options.selectMemory !== undefined ? { selectMemory: options.selectMemory } : {}),
      ...(options.display !== undefined ? { displayIndex: options.display } : {}),
      ...(options.skills !== undefined ? { skills: options.skills } : {}),
      conversation,
      ...(rememberer !== undefined
        ? { onSummarised: (agentId: string, conversationId: string, entries: readonly HistoryEntry[]) => { void rememberer.flush(agentId, conversationId, entries).catch(() => {}); } }
        : {}),
      askUser: async (input: { agentName: string; question: string }) => {
        observations.push({ at: clock++, agent: input.agentName, kind: "call", name: "AskUser:delivered", input: { question: input.question } });
        return "in the app";
      },
    } as never);
  });

  const say = async (line: string): Promise<void> => {
    const before = registry.readTranscript(front.id).length;
    bus.sendFromUser(front.id, line);
    await bus.wake(front.id);
    await bus.idle();
    if (rememberer === undefined) return;
    // The orchestrator's after-turn bookkeeping, on the same terms: the reply read back
    // from the transcript, cited by conversation and time. Settled before the next line,
    // so a scenario asserts on a ledger that has caught up — the production path does not wait.
    const written = registry.readTranscript(front.id).slice(before) as { role?: string; kind?: string; text?: string; at?: string }[];
    const said = written.filter(entry => entry.role === "assistant" && entry.kind === undefined && entry.text).map(entry => entry.text!).join("\n\n");
    const last = written[written.length - 1];
    if (said !== "") await rememberer.record({ agentId: front.id, text: summariseExchange(line, said), ref: memoryRef("main", new Date()), conversation: "main", ...(last?.at !== undefined ? { at: last.at } : {}) });
    await rememberer.settle(front.id);
  };
  if (options.drive !== undefined) await options.drive({ bus, registry, frontId: front.id, files, say });
  for (const line of options.says) await say(line);

  // Errors are read off the transcripts: a refused tool is the rail doing its job, and a
  // scenario asserts on it by name.
  const refusals: string[] = [];
  let questionsRefused = 0;
  for (const record of registry.list()) {
    for (const conversation of [...new Set(["main", ...registry.listConversations(record.id).map(item => item.id)])]) {
      type ResultsEntry = { kind?: string; blocks?: { is_error?: boolean; content?: unknown }[] };
      for (const entry of registry.readAllContextTranscripts(record.id, conversation) as ResultsEntry[]) {
        if (entry.kind !== "results") continue;
        for (const block of entry.blocks ?? []) {
          if (block.is_error !== true) continue;
          const text = Array.isArray(block.content)
            ? (block.content as { text?: string }[]).map(part => part.text ?? "").join(" ")
            : String(block.content ?? "");
          refusals.push(`${record.profile.name}: ${text.slice(0, 140)}`);
          if (/Not asked|cannot ask the person|Decide this one yourself/i.test(text)) questionsRefused += 1;
        }
      }
    }
  }

  const trail = observations.filter(o => o.kind === "call").map(o => `${o.agent}:${o.name}`);
  const said = observations.filter(o => o.kind === "say").map(o => ({ agent: o.agent, text: o.text ?? "" }));
  const firstAnswer = observations.findIndex(o => o.kind === "say" && (o.text ?? "").trim() !== "");
  const score: Scorecard = {
    rounds: calls,
    turns: observations.filter(o => o.kind === "turn").length,
    questions: trail.filter(name => name.endsWith(":AskUser:delivered")).length,
    questionsRefused,
    callsBeforeFirstAnswer:
      firstAnswer < 0
        ? trail.length
        : observations.slice(0, firstAnswer).filter(o => o.kind === "call" && !String(o.name).includes(":")).length,
    peerMessages: observations.filter(o => o.kind === "message").length,
    agents: registry.list().map(record => record.profile.name),
    files: [...files.keys()].sort(),
    trail,
    said,
    refusals,
  };

  return { score, observations, registry, files, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
