/**
 * Wires the registry, the bus, the box, and the turn loop into one runtime.
 *
 * There is deliberately no router here: which agent handles what, and when to
 * involve a teammate, is decided by the models through the messaging tools. The
 * orchestration you see at runtime is emergent, not encoded.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { AgentBus, type BusEvent, type InboundMessage } from "../agents/bus.ts";
import { Inbox, inboxPath } from "../agents/inbox.ts";
import { Claims, claimsPath } from "./claims.ts";
import { FileVersions } from "./files.ts";
import {
  giveUpNote,
  MAX_RESUMES,
  resumePrompt,
  TurnLedger,
  turnLedgerPath,
} from "./resume.ts";
import { AgentRegistry, type AgentRecord } from "../agents/registry.ts";
import type { BoxClient } from "../box/client.ts";
import { DisplayLease } from "../box/display-lease.ts";
import { resolveBoxProvisioner, type BoxProvisioner } from "../box/provisioner.ts";
import type { ResolutionConfig } from "../protocol/index.ts";
import { runTurn, TurnAborted, type TurnEvent } from "./turn.ts";
import { PolicyGate } from "./policy.ts";
import { Rememberer, summariseExchange } from "./remember.ts";
import { SkillCache } from "./skills.ts";
import { Scheduler } from "./schedule.ts";
import { UsageLog } from "./usage.ts";
import {
  createClient,
  resolveSummaryProvider,
  resolveProvider,
  type Effort,
  type ProviderProfile,
} from "./provider.ts";

export interface OrchestratorOptions {
  registry?: AgentRegistry;
  client?: Anthropic;
  /** Which endpoint to talk to. Defaults to whatever the environment selects. */
  provider?: ProviderProfile;
  effort?: Effort;
  /** Connect to a running box. When false, agents run without box tools. */
  useBox?: boolean;
  /**
   * Where the box comes from. Defaults to the environment's choice — a named URL if one
   * is set, Docker otherwise. Injectable so a deployment can supply its own, and so this
   * file no longer knows what Docker is.
   */
  boxProvisioner?: BoxProvisioner;
  onTurnEvent?: (event: TurnEvent) => void;
  onBusEvent?: (event: BusEvent) => void;
  /**
   * Where accepted-but-unstarted work is recorded, so a restart does not lose a request that was
   * already acknowledged. `null` keeps none, which is what a test that should not touch the state
   * directory wants.
   */
  inbox?: Inbox<InboundMessage> | null;
  /**
   * Where turns record that they began, so one interrupted by the process ending can be picked up.
   * `null` keeps none.
   */
  turns?: TurnLedger | null;
  /** Who has taken which piece of work. `null` keeps none. */
  claims?: Claims | null;
}

export class Orchestrator {
  readonly registry: AgentRegistry;
  readonly bus: AgentBus;
  private readonly client: Anthropic;
  private box: BoxClient | undefined;
  private resolution: ResolutionConfig | undefined;
  /**
   * One lease for the whole process, not one per conversation. The display is a
   * property of the box, so scoping this per agent or per turn would let two
   * agents each believe they held it.
   */
  private readonly display = new DisplayLease();
  /** Desktops already brought up, so each is started once per process. */
  private readonly readyDisplays = new Set<number>();
  /**
   * What every turn cost, appended as it happens.
   *
   * One per process rather than per turn: the sequence numbers a collector reads by have to be
   * monotonic across the whole file, and two logs would produce two sequences.
   */
  readonly usage = new UsageLog();

  /**
   * Decides whether a turn may spend, continue, or run a given action.
   *
   * One per process, like the usage log, and for a related reason: its record is append-only and a
   * second instance would interleave two views of the same state. Given the usage log as its
   * spend source, so the budget is measured against what was actually billed rather than an
   * estimate.
   */
  readonly policy = new PolicyGate({
    spendUnavailable: () => this.usage.unavailable(),
    spentSince: sinceMs => {
      const totals = this.usage.totalsSince(sinceMs);
      // Every billed class, not just input and output. The control-plane meter counts cache reads
      // and writes; a local budget that ignored them let a cache-heavy run report near-zero spend
      // while genuinely costing money.
      return (
        totals.inputTokens +
        totals.outputTokens +
        totals.cacheReadTokens +
        totals.cacheWriteTokens
      );
    },
    log: line => console.error(`[policy] ${line}`),
  });

  readonly provider: ProviderProfile;

  /** Begin/end per turn. A begin with no end is a turn the process died underneath. */
  private readonly turns: TurnLedger | undefined;

  /**
   * Which turn each agent is currently resuming, so the ledger entry it writes is linked to the one
   * it is picking up rather than looking like fresh work.
   *
   * Without the link, every resumption would start its own chain and a turn that kills the process
   * would be retried forever — the count is the whole of the crash-loop guard.
   */
  private readonly resuming = new Map<string, { id: string; attempt: number }>();

  /**
   * What each agent last saw each shared file as.
   *
   * One per orchestrator, because the whole point is that it spans agents: they share one work
   * directory as one uid, and two of them writing one file is a lost update with nothing else in
   * the system able to see it.
   */
  private readonly files = new FileVersions();

  /**
   * Who has taken which piece of work.
   *
   * Durable, because the point is surviving the process: in memory it would answer the easy half of
   * the question and fail at a restart, which is exactly when two agents are most likely to pick up
   * the same thing.
   */
  private readonly claims: Claims;

  /**
   * Notices what a conversation taught, after the fact.
   *
   * Given the summariser's profile rather than the agent's: taking notes is the cheapest work in the
   * system and should be billed accordingly.
   */
  private readonly rememberer: Rememberer;

  /** Who last drove each agent, for attributing what it learns. */
  private readonly callers = new Map<string, { userId?: string }>();

  /**
   * Skills as they were last read from the box.
   *
   * Cached because a prompt is built once per turn and reading them is a listing plus a read per
   * skill; four agents waking at once should not produce four scans of the same directory.
   */
  readonly skills = new SkillCache(() => this.box);

  /**
   * Fires skills that carry a schedule.
   *
   * Started by whoever runs the orchestrator rather than in the constructor: a CLI invocation that
   * asks one question should not begin running someone's automations as a side effect.
   */
  readonly scheduler = new Scheduler({
    due: async () => {
      const { skills } = await this.skills.refresh();
      return skills
        .filter(skill => skill.schedule !== undefined)
        .map(skill => ({
          slug: skill.slug,
          name: skill.name,
          path: skill.path,
          schedule: skill.schedule!,
          ...(skill.runAs !== undefined ? { runAs: skill.runAs } : {}),
        }));
    },
    // Through the ordinary prompt path, so a scheduled turn is checked by the policy gate exactly
    // like any other: a box over its budget stops firing rather than quietly draining it.
    run: (agent, prompt) => this.prompt(agent, prompt),
    defaultAgent: () => this.registry.list()[0]?.id,
    log: line => console.error(`[schedule] ${line}`),
  });

  constructor(private readonly options: OrchestratorOptions = {}) {
    this.claims =
      options.claims === null
        ? new Claims(null)
        : (options.claims ?? new Claims(claimsPath(), line => console.error(`[claims] ${line}`)));
    this.turns =
      options.turns === null
        ? undefined
        : (options.turns ??
          new TurnLedger(turnLedgerPath(), line => console.error(`[turns] ${line}`)));
    this.registry = options.registry ?? new AgentRegistry();
    this.provider = options.provider ?? resolveProvider();
    this.client = options.client ?? createClient(this.provider);
    this.rememberer = new Rememberer({
      registry: this.registry,
      client: this.client,
      provider: resolveSummaryProvider(this.provider),
      log: line => console.error(`[memory] ${line}`),
    });

    this.bus = new AgentBus(
      this.registry,
      (agent, inbound, signal) => this.executeTurn(agent, inbound, signal),
      options.onBusEvent,
      options.inbox === null
        ? undefined
        : (options.inbox ??
          new Inbox<InboundMessage>(inboxPath(), line => console.error(`[inbox] ${line}`)))
    );
  }

  /**
   * Attaches to a running box, if there is one.
   *
   * A missing box is not fatal: agents still reason and message each other, they
   * just lose the computer and shell tools, and the prompt says so.
   */
  async connectBox(): Promise<{ connected: boolean; detail: string }> {
    if (this.options.useBox === false) {
      return { connected: false, detail: "box disabled by --no-box" };
    }

    try {
      const provisioner = this.options.boxProvisioner ?? resolveBoxProvisioner();
      const client = await provisioner.connect();
      const health = await client.health();
      this.box = client;
      this.resolution = health.resolution;
      const size = health.resolution
        ? `${health.resolution.display.width}x${health.resolution.display.height}`
        : "no display";
      return { connected: true, detail: `box ready (${size}) via ${provisioner.label}` };
    } catch (error) {
      return {
        connected: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * The agent's own desktop, brought up if this is its first turn.
   *
   * Created on demand rather than at startup so a box with one active agent does
   * not pay for a desktop per registered agent. A failure is not fatal — the agent
   * keeps its shell and file tools — but it is reported, because silently falling
   * back to a shared display is how agents end up typing into each other's windows.
   */
  private async ensureDesktop(agent: AgentRecord): Promise<number | undefined> {
    if (!this.box) return undefined;

    const index = this.registry.displayIndexFor(agent.id);
    if (this.readyDisplays.has(index)) return index;

    try {
      // Claims the desktop as this agent's while creating it: from here on the box
      // refuses input for it that does not carry the same token.
      await this.box.ensureDisplay(index, this.registry.boxOwnerTokenFor(agent.id));
      this.readyDisplays.add(index);
      return index;
    } catch (error) {
      this.options.onBusEvent?.({
        type: "turn_failed",
        agentId: agent.id,
        error:
          `could not start desktop ${index} for ${agent.profile.name}: ` +
          (error instanceof Error ? error.message : String(error)),
        // Nothing was dequeued to get here, so nothing is being held back by this failure.
        waiting: 0,
      });
      return undefined;
    }
  }

  /** The box client, for callers that need the box directly (recording, downloads). */
  boxClient(): BoxClient | undefined {
    return this.box;
  }

  /**
   * Brings up every registered agent's desktop at once.
   *
   * On-demand creation is right for the CLI, but not for a person: they can open
   * any agent's desktop and work in it before that agent has ever taken a turn,
   * and a desktop that does not exist yet shows a proxy error instead of a screen.
   * Failures are collected rather than thrown — one agent's desktop failing must
   * not stop the others from being usable.
   */
  async ensureAllDesktops(): Promise<{ name: string; index: number | undefined }[]> {
    const agents = this.registry.list();
    return Promise.all(
      agents.map(async agent => ({
        name: agent.profile.name,
        index: await this.ensureDesktop(agent),
      }))
    );
  }

  private async executeTurn(
    agent: AgentRecord,
    inbound: readonly InboundMessage[],
    signal: AbortSignal
  ): Promise<void> {
    // Taken, not read: a resumption marker belongs to exactly one turn. Leaving it in place would
    // make every later turn for this agent look like another attempt at the interrupted one, and
    // the attempt count is the whole of the crash-loop guard.
    const resumeOf = this.resuming.get(agent.id);
    this.resuming.delete(agent.id);

    const displayIndex = await this.ensureDesktop(agent);
    // Refreshed before the prompt is built, and never allowed to fail the turn — a box with no
    // skills directory is the normal state of a fresh install.
    const { skills } = await this.skills.refresh();

    return runTurn(agent, inbound, signal, {
      displayIndex,
      boxOwner: this.registry.boxOwnerTokenFor(agent.id),
      usage: this.usage,
      policy: this.policy,
      caller: this.callers.get(agent.id),
      skills,
      client: this.client,
      registry: this.registry,
      files: this.files,
      claims: this.claims,
      bus: this.bus,
      box: this.box,
      display: this.display,
      resolution: this.resolution,
      provider: this.provider,
      effort: this.options.effort,
      turns: this.turns,
      // The same cheap profile the summariser and the note-taker use. Choosing which memories to
      // show is the least interesting work in the system and should be billed accordingly.
      selectMemory: prompt => this.askCheaply(prompt),
      resumeOf,
      onEvent: this.options.onTurnEvent,
    }).catch(error => {
      // An aborted turn is a normal outcome — a priority message superseded it,
      // and the bus will schedule the follow-up turn that handles that message.
      if (error instanceof TurnAborted) return;
      throw error;
    });
  }

  /**
   * Picks up turns the last process died underneath, and says what it did.
   *
   * Called once at startup. Nothing is re-executed: a resumed turn is an ordinary turn whose
   * opening message says what happened, and the model reads its own history — which already holds
   * every completed round — and decides. A call whose result was never written appears there as
   * having an unknown outcome, which is the truth and the only safe thing to say about it.
   */
  resumeInterrupted(): { resumed: number; abandoned: number } {
    const outstanding = this.turns?.interrupted() ?? [];
    let resumed = 0;
    let abandoned = 0;

    for (const turn of outstanding) {
      const agent = this.registry.tryGet(turn.agentId);
      if (agent === undefined) {
        // The agent was deleted while it was working. Nothing to resume onto, and nothing lost that
        // deleting the agent had not already discarded.
        this.turns?.end(turn.id, "agent-gone");
        continue;
      }

      if (turn.attempt >= MAX_RESUMES) {
        // A turn that ends the process will end it again. Reported into the conversation rather
        // than retried: a crash loop that restarts itself is worse than a task that stopped, and
        // the person reading this is the one who can do something about it.
        this.turns?.end(turn.id, "given-up");
        this.registry.appendTranscript(agent.id, {
          role: "assistant",
          text: giveUpNote(turn.about, turn.attempt),
          at: new Date().toISOString(),
        });
        abandoned += 1;
        continue;
      }

      // Closed before the new one opens, so a crash during the resumption leaves exactly one
      // unfinished turn rather than two.
      this.turns?.end(turn.id, "resumed");
      this.resuming.set(agent.id, { id: turn.id, attempt: turn.attempt + 1 });
      this.bus.sendFromUser(agent.id, resumePrompt(turn.about, turn.at));
      resumed += 1;
    }

    return { resumed, abandoned };
  }

  /**
   * One short question to the cheap model, or `undefined` if it could not be asked.
   *
   * Undefined rather than a throw: every caller of this is an improvement to something that already
   * works, so a failure here must degrade rather than propagate.
   */
  private async askCheaply(prompt: string): Promise<string | undefined> {
    try {
      const profile = resolveSummaryProvider(this.provider);
      const response = await this.client.messages.create({
        model: profile.model,
        max_tokens: Math.min(512, profile.maxTokens),
        messages: [{ role: "user", content: prompt }],
      });
      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map(block => block.text)
        .join("\n");
    } catch {
      return undefined;
    }
  }

  /** Sends a user message to an agent and runs its turn to completion. */
  async prompt(
    agentIdOrName: string,
    text: string,
    caller?: { userId?: string }
  ): Promise<void> {
    const agent = this.registry.resolve(agentIdOrName);
    // Remembered for the turn, so a memory kept during it records who it is about. Per agent because
    // two people can be driving two agents at once; overwritten on each prompt because the most
    // recent person to speak to *this* agent is the one its memories are about.
    if (caller?.userId !== undefined) this.callers.set(agent.id, caller);
    this.bus.sendFromUser(agent.id, text);
    const before = this.registry.readTranscript(agent.id).length;
    await this.bus.runExclusive(agent.id, { userDriven: true });

    // After the turn, and not awaited: a person waiting on an answer should not also wait on
    // bookkeeping. What the agent said is read back from the transcript rather than threaded through
    // the turn loop, which keeps the loop unaware that any of this exists.
    const said = this.replySince(agent.id, before);
    if (said !== "") {
      void this.rememberer
        .record({ agentId: agent.id, text: summariseExchange(text, said) })
        .catch(() => {
          // Already logged inside; a second report here would be noise on a path nobody is watching.
        });
    }
  }

  /** The agent's own prose from this turn, which is what an extractor should reason over. */
  private replySince(agentId: string, from: number): string {
    return (this.registry.readTranscript(agentId) as { role?: string; text?: string; kind?: string }[])
      .slice(from)
      .filter(entry => entry.role === "assistant" && entry.kind === undefined && entry.text)
      .map(entry => entry.text as string)
      .join("\n\n");
  }

  /** Waits for every agent woken as a side effect of the last prompt. */
  settle(timeoutMs?: number): Promise<void> {
    return this.bus.idle(timeoutMs);
  }

  /**
   * The starter team, created once when there are no agents at all.
   *
   * The alternative — ship a single blank agent and have it interview the user on its first turn —
   * was considered. That is the better shape when there is a template gallery
   * to choose from afterwards; without one it leaves a person on a blank page deciding what an agent
   * even is. So: a small team that shows the shape of the thing by existing.
   *
   * Four rules, three of them learned rather than invented:
   *
   * **A description is standing identity, never a briefing.** It is re-read into the system prompt on
   * every single turn, so a one-time instruction parked here — "the disk is full", "start by reading
   * the spec" — keeps asserting itself long after it stopped being true, and freezes the tool names
   * that existed the day it was written. What an agent should *do* belongs in a message.
   *
   * **The roster is a cost.** Every agent appears in every other agent's prompt, and a team is also a
   * set of desktops and a set of things a person has to read before doing anything. Four, not ten.
   *
   * **The divisions are real or they are decoration.** These four differ in what they touch and how
   * they fail — a browser and long documents, a shell and installed software, someone else's claims —
   * not in the adjectives describing them. Five flavours of "helpful assistant" would be worse than
   * one agent, because it would imply a structure that does not exist.
   *
   * **Only when empty.** A person who deletes one does not get it back on the next start, and an
   * upgrade does not repopulate a team someone has curated.
   *
   * Deliberately not done: a hidden first turn per agent so each introduces itself. It reads well and
   * it spends four model calls before the user has said anything, which is not a cost to impose by
   * default.
   */
  ensureDefaultAgent(): AgentRecord {
    const existing = this.registry.list();
    if (existing.length > 0) return existing[0]!;

    const created = STARTER_TEAM.map(profile => this.registry.create(profile));
    return created[0]!;
  }
}

/**
 * The team a fresh install starts with.
 *
 * Order matters: the first is the one a CLI and a fresh UI select, so it is the one that talks to
 * people. The rest are its colleagues.
 */
/**
 * Everything a coordinator may do, which is everything.
 *
 * Written as a list rather than as "undefined means all" so the differences below read as
 * subtraction from a stated whole, and so the test that every tool is accounted for has something
 * to compare against.
 */
const ALL_TOOLS: readonly string[] = [
  "computer",
  "bash",
  "read_file",
  "write_file",
  "list_dir",
  "SendToAgent",
  "CreateAgent",
  "UpdateAgent",
  "SetPlan",
  "SetTodos",
  "ReadHistory",
  "ClaimWork",
  "RememberFact",
];

/** Everyone except the coordinator: building the team is the coordinator's job. */
const NO_TEAM_BUILDING: readonly string[] = ALL_TOOLS.filter(
  tool => tool !== "CreateAgent" && tool !== "UpdateAgent"
);

export const STARTER_TEAM: readonly {
  name: string;
  title: string;
  description: string;
  tools?: readonly string[];
}[] = [
  {
    name: "Ada",
    title: "coordinator",
    description:
      "You coordinate this user's team of agents. You are the one they talk to first. " +
      "When a request falls squarely inside a teammate's remit, hand it to them and say " +
      "you did; when the team is missing someone the work clearly needs, propose creating " +
      "them rather than creating them unasked. Do the work yourself when it is faster than " +
      "delegating — a single file read or a one-line shell command is not worth a handoff.",
    tools: ALL_TOOLS,
  },
  {
    name: "Rex",
    title: "researcher",
    description:
      "You find things out. Your work is mostly the browser and the files you write from it: you " +
      "read sources, follow them to their origin rather than trusting a summary of them, and leave " +
      "what you found in a file under /home/box/work so it outlives the conversation. You are " +
      "explicit about what you could not confirm — an unmarked guess in a document you wrote is " +
      "worse than an admitted gap, because the next person cannot tell them apart.",
    tools: NO_TEAM_BUILDING,
  },
  {
    name: "Ops",
    title: "operator",
    description:
      "You do the machine work: installing things, running builds and scripts, moving files, and " +
      "getting a stubborn tool to run at all. You work in the shell by preference because it says " +
      "what happened, and you read what a command actually printed rather than assuming it worked. " +
      "When something needs to survive a rebuild it goes under /home/box/work; when a change is " +
      "hard to undo you say so before making it.",
    tools: NO_TEAM_BUILDING,
  },
  {
    name: "Vera",
    title: "reviewer",
    description:
      "You check whether work actually did what it claims. Given a teammate's result, you read " +
      "their transcript for what they ran and what came back, then reproduce the part that matters " +
      "yourself rather than taking their account of it — the failure you exist to catch is the one " +
      "where a step looked like it worked and did not. You report plainly: what you verified, what " +
      "you could not, and what you found wrong. You do not soften a real problem, and you do not " +
      "invent one to look useful.",
    // The one real division, and the reason this mechanism exists. A reviewer that can rewrite the
    // work is no longer reviewing it — and the failure is not that it would cheat, it is that
    // "fixed it" and "checked it" become the same act and nobody can tell afterwards which happened.
    // It keeps `bash`, because reproducing a step is its whole job and reproducing needs running.
    tools: NO_TEAM_BUILDING.filter(tool => tool !== "write_file"),
  },
];
