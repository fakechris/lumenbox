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
import { loadConfig } from "../config.ts";
import { McpManager } from "./mcp.ts";
import { PolicyGate } from "./policy.ts";
import { TaskStore, type Task } from "./tasks.ts";
import { buildAuditPrompt, manifestDiff, MANIFEST_COMMAND, parseManifest } from "./audit.ts";
import { ScopeStore } from "./scopes.ts";
import { MAIN_CONVERSATION } from "../agents/registry.ts";
import type { HostRunner } from "./host-runner.ts";
import type { Vault } from "./vault.ts";
import { Rememberer, summariseExchange } from "./remember.ts";
import { SkillCache } from "./skills.ts";
import { Scheduler } from "./schedule.ts";
import { UsageLog } from "./usage.ts";
import {
  createClient,
  resolveSummaryProvider,
  resolveProvider,
  effectiveProviderFor,
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
  /**
   * The door out of the box, when an operator built one. Absent means no host
   * execution, and — because the tool is offered only when this is present — an agent
   * never learns it might have asked.
   */
  hostRunner?: HostRunner;
  /** The credential vault, for secrets a host command may ask for by grant. */
  vault?: Vault;
  /** The team's task board. `null` keeps none, which a test that must not touch the state directory wants. */
  tasks?: TaskStore | null;
  /** The scopes registry. `null` keeps none. */
  scopes?: ScopeStore | null;
  /**
   * MCP servers whose tools the agents may call. Absent reads the config file; `null`
   * keeps none, which is what a test that must not spawn a child process wants.
   */
  mcp?: McpManager | null;
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
    spentSincePrincipal: (sinceMs, principalId) =>
      this.usage.spentSincePrincipal(sinceMs, principalId),
    log: line => console.error(`[policy] ${line}`),
  });

  readonly provider: ProviderProfile;

  /**
   * The team's task board. One per process, like the usage log: its file is
   * replay-and-compact and a second writer would interleave two views of the board.
   */
  readonly tasks: TaskStore | undefined;
  readonly scopes: ScopeStore | undefined;

  /**
   * The tools other people wrote, if an operator configured any.
   *
   * One per process like the other stores: each server is a child process, and two
   * managers would mean two of every bridge for no gain.
   */
  readonly mcp: McpManager;

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
    // Its own turn always: a scheduled kickoff absorbed as steering into whatever
    // happens to be running would bury the run's report inside an unrelated reply.
    run: (agent, prompt) => this.prompt(agent, prompt, undefined, { steerable: false }),
    defaultAgent: () => this.registry.list()[0]?.id,
    log: line => console.error(`[schedule] ${line}`),
  });

  /** Tasks whose audit turn is in flight, so an invalidation writing review again does not loop. */
  private readonly auditing = new Set<string>();

  /**
   * The auto-audit: a task landing in review with an agent reviewer wakes that
   * reviewer on an audit turn. The reviewer moves the task itself (the board's
   * review gate is what makes its acceptance mean something); the harness's part
   * is the workspace snapshot around the turn — a review that changed the work is
   * void, said on the task rather than silently accepted.
   */
  private maybeAudit(task: Task): void {
    if (task.status !== "review" || task.reviewerId === undefined) return;
    if (this.auditing.has(task.id)) return;
    const last = task.history[task.history.length - 1];
    // The guard's own invalidation and the reviewer's own moves must not retrigger:
    // after either, the next actor is a person or the assignee, not this machinery.
    if (last?.by === "audit-guard" || last?.by === task.reviewerId) return;
    const reviewer = this.registry.tryGet(task.reviewerId);
    if (reviewer === undefined) return;
    const assignee =
      task.assigneeId !== undefined ? this.registry.tryGet(task.assigneeId) : undefined;

    this.auditing.add(task.id);
    void (async () => {
      try {
        const before = await this.workspaceManifest();
        await this.prompt(
          reviewer.id,
          buildAuditPrompt({
            task,
            assigneeName: assignee?.profile.name ?? task.assigneeId ?? "the assignee",
            ...(task.conversation !== undefined ? { conversation: task.conversation } : {}),
          }),
          undefined,
          { steerable: false }
        );
        const after = await this.workspaceManifest();
        if (before !== undefined && after !== undefined) {
          const changed = manifestDiff(before, after);
          if (changed.length > 0) {
            this.tasks?.update(
              task.id,
              {
                status: "review",
                note:
                  `audit void: the review itself changed ${changed.length} file(s) ` +
                  `(${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""}) — ` +
                  "a reviewer that edits the work is no longer reviewing it",
              },
              "audit-guard"
            );
          }
        }
      } catch (error) {
        console.error(
          `[audit] ${task.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        this.auditing.delete(task.id);
      }
    })();
  }

  /** The box workspace as path→hash, or undefined when there is no box to ask. */
  private async workspaceManifest(): Promise<Map<string, string> | undefined> {
    if (this.box === undefined) return undefined;
    try {
      const result = await this.box.exec(MANIFEST_COMMAND, { timeoutMs: 60_000 });
      return parseManifest(result.stdout ?? "");
    } catch {
      // No manifest means integrity simply is not checked this time — the audit
      // still runs; a broken find must not block review.
      return undefined;
    }
  }

  constructor(private readonly options: OrchestratorOptions = {}) {
    this.tasks =
      options.tasks === null
        ? undefined
        : (options.tasks ?? new TaskStore(undefined, line => console.error(`[tasks] ${line}`)));
    if (this.tasks !== undefined) this.tasks.onChange = task => this.maybeAudit(task);
    this.scopes = options.scopes === null ? undefined : (options.scopes ?? new ScopeStore());
    this.mcp =
      options.mcp === null || options.mcp === undefined
        ? new McpManager(
            options.mcp === null
              ? []
              : Object.entries(loadConfig().mcpServers ?? {}).map(([name, server]) => ({
                  name,
                  ...server,
                })),
            line => console.error(`[mcp] ${line}`)
          )
        : options.mcp;
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
      (agent, inbound, signal, conversation) => this.executeTurn(agent, inbound, signal, conversation),
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
    signal: AbortSignal,
    conversation: string = MAIN_CONVERSATION
  ): Promise<void> {
    // Taken, not read: a resumption marker belongs to exactly one turn. Leaving it in place would
    // make every later turn for this agent look like another attempt at the interrupted one, and
    // the attempt count is the whole of the crash-loop guard.
    const resumeOf = this.resuming.get(agent.id);
    this.resuming.delete(agent.id);

    const displayIndex = await this.ensureDesktop(agent);
    // Started on the first turn that could use them, not at boot: a CLI question should
    // not spawn somebody's bridges as a side effect. Never allowed to fail a turn — a
    // server that is down costs its own tools and nothing else.
    if (this.mcp.configured) await this.mcp.ready();
    // Refreshed before the prompt is built, and never allowed to fail the turn — a box with no
    // skills directory is the normal state of a fresh install.
    const { skills } = await this.skills.refresh();

    // Agent identity and runtime are separate: an agent may name its own provider or
    // model, and gets its own client for it. Absent, it runs on the installation's.
    const runtime = this.runtimeForAgent(agent);

    return runTurn(agent, inbound, signal, {
      displayIndex,
      boxOwner: this.registry.boxOwnerTokenFor(agent.id),
      usage: this.usage,
      policy: this.policy,
      caller: this.callers.get(agent.id),
      skills,
      client: runtime.client,
      registry: this.registry,
      files: this.files,
      claims: this.claims,
      bus: this.bus,
      box: this.box,
      display: this.display,
      resolution: this.resolution,
      hostRunner: this.options.hostRunner,
      vault: this.options.vault,
      tasks: this.tasks,
      scopes: this.scopes,
      mcp: this.mcp,
      conversation,
      provider: runtime.provider,
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
      this.bus.sendFromUser(agent.id, resumePrompt(turn.about, turn.at), {
        // The turn resumes in the conversation it was interrupted in: an answer to a
        // group chat's question must not surface in the team room.
        ...(turn.conversation !== undefined ? { conversation: turn.conversation } : {}),
        // And always on its own turn: a resume absorbed as steering into some other
        // running work would bury the recovery in an unrelated reply.
        steerable: false,
      });
      // Enqueuing is not running. sendFromUser only queues; without this the resumed turn sat until
      // some unrelated later traffic happened to wake the agent. recover() wakes for the inbox; this
      // path did not.
      void this.bus.wake(agent.id);
      resumed += 1;
    }

    return { resumed, abandoned };
  }

  /**
   * The client and provider an agent runs on — its own override, or the default.
   *
   * Clients are cached by the provider's shape (label, model, base URL): building one
   * per turn would be waste, and a run is bounded by desktops. A per-agent provider
   * whose credential is missing is *not* silently fallen back to the default — that is
   * the exact silent-model-swap the config work fixed; the turn should fail with a
   * clear message, which `createClient` already throws. So a build failure here is
   * caught by the turn, not hidden.
   */
  private readonly runtimeCache = new Map<string, { client: Anthropic; provider: ProviderProfile }>();

  private runtimeForAgent(agent: AgentRecord): { client: Anthropic; provider: ProviderProfile } {
    const provider = effectiveProviderFor(agent.profile, this.provider);
    if (provider === this.provider) return { client: this.client, provider: this.provider };
    const key = `${provider.label} ${provider.model} ${provider.baseUrl ?? ""}`;
    const cached = this.runtimeCache.get(key);
    if (cached !== undefined) return cached;
    const runtime = { client: createClient(provider), provider };
    this.runtimeCache.set(key, runtime);
    return runtime;
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
    caller?: { userId?: string },
    options: { conversation?: string; steerable?: boolean } = {}
  ): Promise<void> {
    const agent = this.registry.resolve(agentIdOrName);
    const conversation = options.conversation ?? MAIN_CONVERSATION;
    // Remembered for the turn, so a memory kept during it records who it is about. Per agent because
    // two people can be driving two agents at once; overwritten on each prompt because the most
    // recent person to speak to *this* agent is the one its memories are about.
    if (caller?.userId !== undefined) this.callers.set(agent.id, caller);
    this.bus.sendFromUser(agent.id, text, {
      conversation,
      ...(options.steerable === false ? { steerable: false } : {}),
    });
    const before = this.registry.readTranscript(agent.id, conversation).length;
    await this.bus.runExclusive(agent.id, { userDriven: true, conversation });

    // After the turn, and not awaited: a person waiting on an answer should not also wait on
    // bookkeeping. What the agent said is read back from the transcript rather than threaded through
    // the turn loop, which keeps the loop unaware that any of this exists.
    const said = this.replySince(agent.id, before, conversation);
    if (said !== "") {
      void this.rememberer
        .record({ agentId: agent.id, text: summariseExchange(text, said) })
        .catch(() => {
          // Already logged inside; a second report here would be noise on a path nobody is watching.
        });
    }
  }

  /**
   * The agent's own prose since a transcript position — what an extractor reasons
   * over, and what a chat channel sends back as the reply.
   */
  replySince(agentId: string, from: number, conversation: string = MAIN_CONVERSATION): string {
    return (this.registry.readTranscript(agentId, conversation) as { role?: string; text?: string; kind?: string }[])
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
   * is the better shape when there is a template gallery to choose from afterwards; without one it
   * leaves a person on a blank page deciding what an agent even is. So: a small team that shows the
   * shape of the thing by existing.
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
export const ALL_TOOLS: readonly string[] = [
  "computer",
  "bash",
  "Jobs",
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
  "Tasks",
  "RunOnHost",
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
