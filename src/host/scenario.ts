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

import type Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import { runTurn } from "./turn.ts";
import { fakeModel } from "./testing/fake-model.ts";
import type { BoxClient } from "../box/client.ts";

/** One model reply, in the shape the script writes it. */
export type ScriptedReply =
  | { say: string }
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
}

/** What the script does at each model call. Returning undefined ends the turn silently. */
export type Script = (context: ScriptContext) => ScriptedReply | undefined;

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
function memoryBox(files: Map<string, string>): BoxClient {
  const box = {
    exec: async (command: string) => {
      // Enough shell for a scenario: mkdir and echo-into-file are what agents actually reach for.
      const redirect = /^echo\s+"?(.*?)"?\s*>\s*(\S+)$/.exec(command.trim());
      if (redirect) {
        files.set(redirect[2]!, redirect[1]!);
        return { exit_code: 0, stdout: "", stderr: "" };
      }
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
  /** What the model does. */
  script: Script;
  /** Files the box starts with. */
  files?: Record<string, string>;
  /** Stops an episode that will not settle. Default 200. */
  maxRounds?: number;
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
  const box = memoryBox(files);
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

  const client = fakeModel(({ params }) => {
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
    const reply = options.script({ agent, system, round, opened, offered });
    if (reply === undefined) return message([{ type: "text", text: "" } as Anthropic.ContentBlock], "end_turn");
    if ("say" in reply) {
      observations.push({ at: clock++, agent, kind: "say", text: reply.say });
      return message([{ type: "text", text: reply.say } as Anthropic.ContentBlock], "end_turn");
    }
    observations.push({ at: clock++, agent, kind: "call", name: reply.call, input: reply.input });
    return message(
      [{ type: "tool_use", id: `t${clock}`, name: reply.call, input: reply.input } as unknown as Anthropic.ContentBlock],
      "tool_use"
    );
  });

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
      registry,
      bus,
      box,
      resolution: undefined,
      conversation,
      askUser: async (input: { agentName: string; question: string }) => {
        observations.push({ at: clock++, agent: input.agentName, kind: "call", name: "AskUser:delivered", input: { question: input.question } });
        return "in the app";
      },
    } as never);
  });

  for (const line of options.says) {
    bus.sendFromUser(front.id, line);
    await bus.wake(front.id);
    await bus.idle();
  }

  // Errors are read off the transcripts: a refused tool is the rail doing its job, and a
  // scenario asserts on it by name.
  const refusals: string[] = [];
  let questionsRefused = 0;
  for (const record of registry.list()) {
    for (const conversation of [{ id: "main" }, ...registry.listConversations(record.id)]) {
      type ResultsEntry = { kind?: string; blocks?: { is_error?: boolean; content?: unknown }[] };
      for (const entry of registry.readTranscript(record.id, conversation.id) as ResultsEntry[]) {
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
