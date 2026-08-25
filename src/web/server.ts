/**
 * A local web UI for driving and watching the agents.
 *
 * Exists for acceptance testing: the CLI can show one agent's turn, but the thing
 * worth checking by hand is the part a transcript cannot convey — several agents
 * working at once, one handing work to another, and the desktop changing under
 * them. Three panes, one event stream.
 *
 * Binds to loopback only. There is no authentication, because anything that can
 * reach this port can already drive the agents; keeping it off the network is the
 * control.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRegistry, MAIN_CONVERSATION, conversationIdFor } from "../agents/registry.ts";
import type { BusEvent } from "../agents/bus.ts";
import { BoxManager, defaultBoxConfig } from "../box/docker.ts";
import { resolveBoxProvisioner, type BoxProvisioner } from "../box/provisioner.ts";
import { envNumber } from "../config.ts";
import { BackupSchedule, backupRoot } from "../host/backup.ts";
import { Orchestrator } from "../host/orchestrator.ts";
import { describeProvider, type ProviderProfile } from "../host/provider.ts";
import type { TurnEvent } from "../host/turn.ts";
import { APP_HTML, LOGIN_HTML } from "./app-html.ts";
import {
  authorize,
  callerOf,
  COOKIE_NAME,
  isLoopback,
  mayDrive,
  parseCookies,
  refusalToDrive,
  type Caller,
} from "./auth.ts";
import {
  newWebIdentity,
  readSession,
  SESSION_COOKIE,
  sessionCookie,
  sessionKey,
  SESSION_MAX_AGE_SECONDS,
} from "./session.ts";

/**
 * The one directory a person may browse, and the one that survives a rebuild.
 *
 * Those being the same set is deliberate: "you can download it" and "it will still be here
 * tomorrow" are then one rule rather than two.
 */
const WORK_DIR = process.env.AGENTBOX_WORK_DIR ?? "/home/box/work";

/**
 * The tool list from a request body: an array of known names, `null` for "all",
 * `undefined` for "not provided", or an Error naming what was wrong.
 */
function readToolList(value: unknown): readonly string[] | null | undefined | Error {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    return new Error("tools must be an array of tool names");
  }
  const unknown = (value as string[]).filter(name => !ALL_TOOLS.includes(name));
  if (unknown.length > 0) {
    return new Error(`Unknown tools: ${unknown.join(", ")}. Known: ${ALL_TOOLS.join(", ")}.`);
  }
  return value as string[];
}

/**
 * Which code is running, for reading a bug report against the right build.
 *
 * Version from package.json; commit from git, asked once at startup — a deployment
 * without a git checkout says so via AGENTBOX_BUILD or shows "unknown", which is
 * still more honest than showing nothing and guessing later.
 */
function buildInfo(): { version: string; commit: string } {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // The page shows 0.0.0, which reads as "could not tell" and is exactly true.
  }
  let commit = process.env.AGENTBOX_BUILD ?? "";
  if (commit === "") {
    try {
      commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      commit = "unknown";
    }
  }
  return { version, commit };
}

/**
 * The exit code that means "start me again with the new config".
 *
 * 75 is EX_TEMPFAIL — a temporary condition, try again — which is exactly what a
 * settings-driven restart is. The desktop shell relaunches on it; any other exit is a
 * stop or a crash and is treated as one.
 */
export const RESTART_EXIT_CODE = 75;

/**
 * Whether a path is inside the work directory, textually.
 *
 * A prefix check on a normalised path, which stops `..` and a bare `/etc/passwd`. It does *not* stop
 * a symlink pointing out of the tree — that is checked in the daemon with `realpath`, where the
 * filesystem actually is. Both, because this one is reachable by anyone with a UI token.
 */
function withinWork(path: string): boolean {
  if (path.includes("\0")) return false;
  const normalised = posix.normalize(path);
  return normalised === WORK_DIR || normalised.startsWith(`${WORK_DIR}/`);
}

/**
 * One line of "what is it doing", for a chat task card.
 *
 * The tool name is the truth; the argument shown is the one a person recognises — a
 * command, a path, a URL — clamped hard, because a card is glanced at, not read.
 */
function actionLine(tool: string, input: unknown): string {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const detail = [record.command, record.path, record.action, record.url].find(
    (value): value is string => typeof value === "string" && value !== ""
  );
  const line = detail === undefined ? tool : `${tool}: ${detail}`;
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}
import { agentboxHome, loadConfig, saveConfig, type AgentboxConfig } from "../config.ts";

type AgentboxConfigHostExec = NonNullable<AgentboxConfig["hostExec"]>;
import { ChannelManager } from "../channels/manager.ts";
import { DingTalkChannel } from "../channels/dingtalk.ts";
import { FeishuChannel } from "../channels/feishu.ts";
import { TelegramChannel } from "../channels/telegram.ts";
import { HostRunner, hostRunnerConfig } from "../host/host-runner.ts";
import { ALL_TOOLS } from "../host/orchestrator.ts";
import { preflight } from "../box/preflight.ts";
import { rescueMessage, rescueStuck } from "../host/rescue.ts";
import { Deliveries, deliveriesPath } from "../host/deliveries.ts";
import { Ingress, ingressPath } from "../channels/ingress.ts";
import { randomUUID } from "node:crypto";
import { adminRecipients, decideUpgrade, upgradeMessage } from "../host/upgrade.ts";
import { PRESET_MODELS, providerNames, resolveProvider, testProvider } from "../host/provider.ts";
import { Principals, roleAtLeast, type Principal, type Role } from "../host/principals.ts";
import { describeTask, isLive, isTaskStatus } from "../host/tasks.ts";
import { TOOL_BUDGET_WARNING } from "../host/mcp.ts";
import {
  handleMcpRequest,
  mintMcpToken,
  principalForToken,
  type McpAccessToken,
  type McpServerTool,
} from "./mcp-server.ts";
import { Vault, type Grant } from "../host/vault.ts";
import { seedStarterSkills } from "../host/starter-skills.ts";
import { ActivityLog } from "./activity.ts";
import { vendorPath } from "./markdown.ts";
import { toDisplayEntries } from "./transcript.ts";

export interface WebOptions {
  port: number;
  /**
   * Shared secret for the UI. Anyone holding it can drive the agents, which is the whole
   * access model: there are no users, only whoever has the token.
   */
  token?: string;
  /** Where the box comes from. Defaults to the environment's choice. */
  boxProvisioner?: BoxProvisioner;
  host?: string;
  /**
   * Which endpoint to use. Optional because it is resolved from the config when
   * absent — it was required in the type and defaulted nowhere, so the two routes
   * that read it answered 500 for any caller that left it out.
   */
  provider?: ProviderProfile;
  useBox?: boolean;
  onReady?: (url: string) => void;
  onLog?: (line: string) => void;
}

/** Anything pushed to the browser. Turn and bus events plus a few of our own. */
type OutboundEvent =
  | TurnEvent
  | BusEvent
  | { type: "prompt"; agentId: string; text: string; userId?: string; conversation?: string }
  | { type: "error"; message: string }
  /** One line of docker output while the box is brought up from the page. */
  | { type: "box_setup"; line: string; done?: boolean; ok?: boolean }
  /** An approval was just created; the desktop shell turns this into a notification. */
  | { type: "approval_pending"; agentId: string; agentName: string; description: string };

export async function startWebServer(options: WebOptions): Promise<() => void> {
  const log = options.onLog ?? (() => {});
  const registry = new AgentRegistry();
  /** Read once on first request; it never changes while the server is up. */
  let vendorScript: Buffer | undefined;
  /** The woff2 faces, read once each. Seven files, ~400 KB total. */
  const fontCache = new Map<string, Buffer>();
  /** Asked once: the answer cannot change while this process runs. */
  const build = buildInfo();
  /** One docker bring-up at a time; a second click joins the first via the events. */
  let boxUpInFlight = false;
  const clients = new Set<ServerResponse>();

  /**
   * Recent activity, so the feed is not blank on arrival.
   *
   * The feed used to exist only in the page: it showed what happened since the tab
   * loaded and lost all of it on reload, which is exactly when someone comes back to
   * see what the agents did. Kept bounded and in memory — this is a view of a run, not
   * a record of it; the transcripts on disk are the record.
   *
   * Text deltas are left out (there are thousands, and the transcript has them) and so
   * are screenshots, which would make this hold megabytes of base64. Events that draw
   * no line are skipped: this exists to fill the feed, not to mirror the stream.
   *
   * On disk, because in one process's memory it survived a browser reload but not a
   * restart — see src/web/activity.ts. How much to keep is a preference someone sets
   * once, so it lives in the config file rather than in an environment variable.
   */
  const activityLimit = loadConfig(line => log(line)).activityLimit;
  const activity = new ActivityLog({
    path: join(agentboxHome(), "activity.jsonl"),
    limit: activityLimit,
    onWarn: line => log(line),
  });

  const FEED_EVENTS = new Set([
    "prompt",
    "turn_started",
    "turn_failed",
    "turn_interrupted",
    "tool_start",
    "message_sent",
    "error",
  ]);

  const remember = (event: OutboundEvent) => {
    if (!FEED_EVENTS.has(event.type)) return;
    activity.add(event as unknown as Record<string, unknown> & { type: string });
  };

  const broadcast = (event: OutboundEvent) => {
    remember(event);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      // A slow or dead client must not take the server down with it.
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  };

  const provisioner = options.boxProvisioner ?? resolveBoxProvisioner();

  /**
   * Answers owed to a chat, so one that was earned while the process died still arrives.
   * See deliveries.ts: the reply itself is never stored, only where it belongs.
   */
  const deliveries = new Deliveries(deliveriesPath(agentboxHome()));

  /**
   * The channels, once they exist — held with a written type on purpose.
   *
   * The orchestrator needs to reach them (to put an agent's question to a person) and
   * they need to reach the orchestrator (to run a turn), which is a cycle TypeScript
   * cannot infer its way around: it gives up and hands back `any` in places unrelated
   * to either. Naming the type breaks the cycle without pretending it is not there.
   */
  let chats: ChannelManager | undefined;

  // Optional in the type and not in the code: two routes read it unconditionally, so a
  // caller that omitted it got a 500 from the page's own state endpoint. Resolved once
  // here rather than defended at each use, which is how one of them ends up missing it.
  const provider = options.provider ?? resolveProvider(loadConfig().provider);

  // The moment an agent starts waiting on a person is worth pushing, not only
  // polling: the desktop shell turns this into a system notification, which is the
  // only way to learn about it while the window is closed.
  const announceApproval = (approval: {
    agentId: string;
    agentName: string;
    description: string;
  }) => {
    broadcast({
      type: "approval_pending",
      agentId: approval.agentId,
      agentName: approval.agentName,
      description: approval.description,
    });
  };

  // The door out of the box, built from config: off unless an operator turned it on.
  // Read once at construction — a change to it takes effect at the next restart, the
  // same as the provider, because it decides what tools an agent is even offered.
  const hostRunner = new HostRunner(hostRunnerConfig(loadConfig().hostExec ?? {}));
  if (hostRunner.enabled) log("host execution is on; every host command still asks for approval");

  // The credential vault. Read fresh on each edit through the routes; the orchestrator
  // holds this one instance, so a granted secret is usable on the next host command.
  const vault = new Vault();

  // Channel task cards listen here while their ask is in flight: each listener is a
  // narrow filter on (agent, conversation), added before the prompt and removed after
  // it settles. A set rather than a rewiring of onTurnEvent per ask, because two chats
  // can be driving two agents at once.
  const channelTurnListeners = new Set<(event: TurnEvent) => void>();

  const orchestrator = new Orchestrator({
    registry,
    provider,
    useBox: options.useBox,
    boxProvisioner: provisioner,
    hostRunner,
    vault,
    // An agent that cannot proceed without knowing something asks the person who gave
    // it the work — the same routing an approval uses, because the person who asked
    // for it is the one who can say what they meant. It reaches their chat and the
    // page; the reply is an ordinary message, so nothing here has to hold a turn open.
    askUser: async input => {
      broadcast({
        type: "error",
        message: `${input.agentName} asked: ${input.question}`,
      });
      const where = chats?.askQuestion(input);
      // The page is always a place an answer can come from, so a question is never
      // undeliverable while somebody could be looking at it.
      return where ?? "in the app";
    },
    onTurnEvent: event => {
      broadcast(event);
      for (const listener of channelTurnListeners) listener(event);
    },
    onBusEvent: broadcast,
  });

  // ── chat channels ────────────────────────────────────────────────────────────
  //
  // Each is enabled by its credentials being present — including via the config
  // file's env map — and every message runs an ordinary turn through the ordinary
  // gates. The allow list is read fresh per message, so adding someone needs no
  // restart.
  // The people, and the one-time migration from the old flat allow list: every
  // identity that used to be a bare channel grant becomes a driver principal, so a
  // person's existing access survives the upgrade rather than being silently revoked.
  const principals = new Principals();
  {
    const legacy = loadConfig().channelAllow ?? [];
    const unclaimed = legacy.filter(identity => !principals.isKnown(identity));
    if (unclaimed.length > 0) {
      principals.save([
        ...principals.list(),
        ...unclaimed.map(identity => ({
          id: identity,
          name: identity,
          role: "driver" as const,
          identities: [identity],
        })),
      ]);
      saveConfig({ channelAllow: null });
      log(`migrated ${unclaimed.length} channel grant(s) to driver principals`);
    }
  }

  // Letting somebody in is one click, not an id copied around. A stranger's message
  // records a knock; the settings dialog approves it with one button, or the owner
  // hands out a short-lived invite code the person redeems in the chat itself.
  // In memory on purpose: a knock lost to a restart costs the person one more
  // message, and a code that did not outlive the process is a *property* of a code.
  /**
   * Access tokens for the MCP side door, one per person per client.
   *
   * In memory, matching the invite codes above: a token that does not survive a
   * restart is a token nobody has to remember to revoke, and re-issuing one is a
   * click. Persisting them is the change to make when somebody's IDE is annoyed by
   * it, not before.
   */
  const mcpTokens: McpAccessToken[] = [];

  const knocks = new Map<
    string,
    { identity: string; senderLabel: string; channel: string; at: string }
  >();
  const invites = new Map<string, { role: Role; principalId?: string; expiresAt: number }>();
  const INVITE_TTL_MS = 15 * 60_000;
  const newInviteCode = (): string => {
    // Unambiguous alphabet — no 0/O, 1/I/L — because this travels by voice and by
    // hand. Six characters of 31 ≈ 10^9, plenty for 15 minutes and one use.
    const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    return Array.from(randomBytes(6), byte => alphabet[byte % alphabet.length]!).join("");
  };

  // The chat's day, from the objects that already record it: the board for what
  // happened, usage for what it cost, the policy gate for what waits on a person.
  // Deliberately not a model call — a digest that could hallucinate its numbers
  // would poison the one place those numbers are read daily.
  const digestFor = (chatKey: string): string => {
    // Every thread in the chat, not just one. A digest is about the room's day, and the
    // room's day is now spread across a conversation per topic.
    const conversation = conversationIdFor(chatKey);
    const all = (orchestrator.tasks?.list() ?? []).filter(
      task =>
        task.conversation === conversation ||
        (task.conversation ?? "").startsWith(`${conversation}-`)
    );
    const since = Date.now() - 24 * 3_600_000;
    const nameOf = (id: string) =>
      registry.tryGet(id)?.profile.name ??
      principals.list().find(person => person.id === id)?.name ??
      id;
    const closed = all.filter(
      task => !isLive(task.status) && Date.parse(task.updatedAt) >= since
    );
    const live = all.filter(task => isLive(task.status));
    // Every line points at the thing it claims. A briefing exists so somebody can
    // understand the day in a minute and intervene where judgement changes the
    // outcome — which needs one click from any claim to its evidence, not a summary
    // to be taken on faith.
    const base = process.env.AGENTBOX_PUBLIC_URL?.replace(/\/+$/, "");
    const cite = (task: { id: string }) =>
      base === undefined || base === "" ? task.id : `${task.id} (${base}/?task=${task.id})`;
    const lines = ["Daily briefing"];
    lines.push(
      closed.length > 0
        ? `Closed (24h): ${closed.map(task => `${cite(task)} ${task.title}`).join(" · ")}`
        : "Closed (24h): nothing"
    );
    if (live.length > 0) {
      lines.push(
        `In flight: ${live
          .map(
            task =>
              `${cite(task)} [${task.status}]${task.assigneeId !== undefined ? ` @${nameOf(task.assigneeId)}` : ""} ${task.title}`
          )
          .join(" · ")}`
      );
    }
    // What the board is holding for somebody: the tasks a person, not an agent, has
    // to move next. Named separately because a blocked row buried in "in flight" is
    // how work quietly stops.
    const waiting = live.filter(task => task.status === "blocked" || task.status === "review");
    if (waiting.length > 0) {
      lines.push(
        `Needs a person: ${waiting.map(task => `${cite(task)} [${task.status}]`).join(" · ")}`
      );
    }
    const requesters = [
      ...new Set(all.filter(task => Date.parse(task.updatedAt) >= since).map(task => task.requester)),
    ];
    const spend = requesters
      .map(id => ({ id, tokens: orchestrator.usage.spentSincePrincipal(since, id) }))
      .filter(entry => entry.tokens > 0);
    if (spend.length > 0) {
      lines.push(
        `Spend (24h): ${spend
          .map(entry => `${nameOf(entry.id)} ~${Math.round(entry.tokens / 1000)}k tokens`)
          .join(", ")}`
      );
    }
    const pending = orchestrator.policy.pending();
    if (pending.length > 0) {
      lines.push(
        `Waiting on a person: ${pending.length} approval${pending.length === 1 ? "" : "s"} ` +
          `(${[...new Set(pending.map(item => item.agentName))].join(", ")})`
      );
    }
    return lines.join("\n");
  };

  /**
   * Every arrival from outside, and what became of it. See ingress.ts: a message that
   * arrived and went nowhere used to leave the same trace as one that never arrived.
   */
  const ingress = new Ingress(ingressPath(agentboxHome()));

  const channels = new ChannelManager({
    ingress,
    mayDrive: identity => roleAtLeast(principals.roleOf(identity), "driver"),
    mayAdmin: identity => roleAtLeast(principals.roleOf(identity), "admin"),
    // One scope per chat: binding moves the chat, it does not accumulate. The scope
    // itself is created and given tools in Settings; the chat only chooses which one
    // bounds it.
    chatScope: {
      show: chatKey => {
        const bound = orchestrator.scopes?.boundTo(conversationIdFor(chatKey), conversationIdFor);
        if (bound === undefined) {
          return 'This chat is not bound to a scope. An admin binds one with "scope <name>".';
        }
        const tools = bound.tools !== undefined ? ` Tools: ${bound.tools.join(", ")}.` : "";
        return `This chat is bound to scope "${bound.name}".${tools}`;
      },
      bind: (chatKey, name) => {
        const scopes = orchestrator.scopes;
        if (scopes === undefined) return "Scopes are not available on this installation.";
        const all = scopes.list();
        const target = all.find(scope => scope.name === name || scope.id === name);
        if (target === undefined) {
          const names = all.map(scope => scope.name).join(", ");
          return `No scope named "${name}". ${names !== "" ? `Existing: ${names}.` : "Create one under Settings → Scopes first."}`;
        }
        for (const scope of all) scope.chats = (scope.chats ?? []).filter(key => key !== chatKey);
        target.chats = [...(target.chats ?? []), chatKey];
        scopes.save(all);
        log(`scope: ${chatKey} bound to ${target.id}`);
        const tools = target.tools !== undefined ? ` Tools narrow to: ${target.tools.join(", ")}.` : "";
        return `Bound. Every task in this chat now runs inside "${target.name}".${tools}`;
      },
      off: chatKey => {
        const scopes = orchestrator.scopes;
        if (scopes === undefined) return "Scopes are not available on this installation.";
        const all = scopes.list();
        for (const scope of all) scope.chats = (scope.chats ?? []).filter(key => key !== chatKey);
        scopes.save(all);
        log(`scope: ${chatKey} unbound`);
        return "Unbound. Tasks in this chat run with each agent's own tools again.";
      },
    },
    digest: {
      build: digestFor,
      schedule: (chatKey, hour) => {
        saveConfig({ digests: { [chatKey]: hour } });
        log(`digest: ${chatKey} daily at ${hour}:00`);
        return `Daily digest set for ${hour}:00. "早报" reads it any time; "早报 关" stops it.`;
      },
      off: chatKey => {
        saveConfig({ digests: { [chatKey]: null } });
        log(`digest: ${chatKey} off`);
        return "Daily digest off for this chat.";
      },
    },
    knock: request => {
      knocks.set(request.identity, { ...request, at: new Date().toISOString() });
      log(`channel ${request.channel}: ${request.senderLabel} (${request.identity}) knocked`);
    },
    bind: (code, identity, senderLabel) => {
      const invite = invites.get(code);
      if (invite === undefined || invite.expiresAt < Date.now()) {
        invites.delete(code);
        return "That code is not live — codes last 15 minutes and work once. Ask for a fresh one.";
      }
      // Deleted before the roster write: a code that races two senders admits one.
      invites.delete(code);
      const roster = principals.list();
      const target =
        invite.principalId !== undefined
          ? roster.find(principal => principal.id === invite.principalId)
          : undefined;
      if (target !== undefined) {
        target.identities.push(identity);
        principals.save(roster);
        knocks.delete(identity);
        log(`channel bind: ${identity} linked to ${target.name}`);
        return `Linked — you are ${target.name} (${target.role}) here now. Just say what you need done.`;
      }
      roster.push({ id: identity, name: senderLabel, role: invite.role, identities: [identity] });
      principals.save(roster);
      knocks.delete(identity);
      log(`channel bind: ${identity} joined as ${invite.role}`);
      return `You're in as ${invite.role}. Just say what you need done; @AgentName first picks who does it.`;
    },
    // A chat reply of allow/always/deny answers the approval that was pushed there.
    answerApproval: (approvalId, reply) => {
      const target = orchestrator.policy.pending().find(item => item.id === approvalId);
      if (target === undefined) return undefined;
      if (reply === "deny") {
        orchestrator.policy.deny(approvalId, "channel");
        broadcast({ type: "error", message: `${target.agentName} was refused from a chat.` });
        return "Refused. The turn will not run that action.";
      }
      orchestrator.policy.grant(approvalId, "channel", reply);
      return reply === "always"
        ? "Allowed, and I will not ask you for this exact action again. " +
          "Send the agent a message to have it retry."
        : reply === "session"
          ? "Allowed for this session. Send the agent a message to have it retry."
          : "Allowed once. Send the agent a message to have it retry.";
    },
    log: line => log(line),
    ask: async (agentName, text, identity, chatKey, onProgress, threadKey, taskId) => {
      const agent =
        agentName !== undefined
          ? registry.resolve(agentName)
          : (registry.list()[0] ?? orchestrator.ensureDefaultAgent());
      channels.remember(agent.id, identity.split(":")[0] ?? "", identity);
      // Each outside chat is its own conversation thread: two groups talking to the
      // same agent never read each other's context. Permission stays with the person
      // (identity); context stays with the room (chatKey); spend is billed to the
      // principal the identity resolves to, so one person's several phones are one bill.
      // The thread, not the chat. A room running for days was one unbounded transcript,
      // so a finished investigation kept steering unrelated questions; every mature
      // integration read for this keys on the thread and falls back to the message. The
      // chat stays the address — replies, files and the outbox still go to the room.
      const conversation = conversationIdFor(threadKey ?? chatKey);
      const principal = principals.resolve(identity).id;

      // Made before the turn, because the prompt states the path as a fact — "its
      // directory on the box is X/" — while the directory was created lazily, on the first
      // file in or out. An agent that went looking found nothing and said so, correctly;
      // it then put a deliverable somewhere nobody would collect it. Rare before, because
      // most turns never touch the outbox, and constant afterwards, because a conversation
      // per topic means most turns now start with no directory at all.
      void orchestrator
        .boxClient()
        ?.exec(`mkdir -p '${WORK_DIR}/chats/${conversation}/inbox' '${WORK_DIR}/chats/${conversation}/outbox'`)
        .catch((error: unknown) => {
          log(
            `could not create the file exchange for ${conversation}: ` +
              `${error instanceof Error ? error.message : String(error)}`
          );
        });
      const before = registry.readTranscript(agent.id, conversation).length;
      // Written before the turn runs, not after it returns. This note is what lets any
      // later process recover the answer: everything the agent says past `before` in this
      // conversation is the reply to this request, and the transcript is already durable.
      const owed = randomUUID();
      deliveries.open({
        id: owed,
        chatKey,
        conversation,
        agentId: agent.id,
        before,
        identity,
        ...(taskId !== undefined ? { taskId } : {}),
        at: new Date().toISOString(),
      });
      broadcast({ type: "prompt", agentId: agent.id, text, userId: principal, conversation });
      // The card's one-line answer to "what is it doing": each tool call as it starts,
      // for this agent in this conversation only. Coarse on purpose — a card is not a
      // transcript, and the transcript is where the real record already lives. The
      // bare tool name rides along for the manager's own judgements.
      // A turn that gave up is not a turn that finished: the chat should see the red
      // card and the board the blocked row, so the loop report is raised as the
      // failure it is for anyone waiting on this work.
      let stuck: string | undefined;
      const listener = (event: TurnEvent) => {
        if (event.agentId !== agent.id || event.conversation !== conversation) return;
        if (event.type === "stuck") {
          stuck = event.reason;
          return;
        }
        if (event.type === "tool_start") {
          onProgress?.(actionLine(event.tool, event.input), event.tool);
        }
      };
      channelTurnListeners.add(listener);
      try {
        await orchestrator.prompt(agent.id, text, { userId: principal }, { conversation });
        await orchestrator.settle();
      } finally {
        channelTurnListeners.delete(listener);
      }
      if (stuck !== undefined) {
        // A turn that gave up owes no answer; the card goes red and the board blocked.
        deliveries.close(owed);
        throw new Error(stuck);
      }
      const reply = orchestrator.replySince(agent.id, before, conversation);
      // Closed here rather than after the channel's send: the channel is about to deliver
      // it in this same tick, and a send that fails leaves the message in the outbox
      // rather than needing this queue as a second retry mechanism.
      deliveries.close(owed);
      return reply;
    },
    // Channel requests live on the team board: "t12" means the same thing in the
    // chat's card, the web UI and an agent's prompt. A failure closes as blocked with
    // its note — a board that loses failed work answers "what needs somebody" wrong.
    board: {
      open: input => {
        const tasks = orchestrator.tasks;
        if (tasks === undefined) return undefined;
        let assigneeId: string | undefined;
        try {
          assigneeId = (input.agentName !== undefined
            ? registry.resolve(input.agentName)
            : registry.list()[0]
          )?.id;
        } catch {
          // The unknown-agent error is thrown (and relayed) by ask; the board entry
          // simply goes unassigned.
        }
        // A reviewer if the team has one that is not the assignee: naming it here is
        // what makes the review gate — and the audit turn behind it — apply to work
        // asked for from a chat, where nobody is watching the board. An installation
        // with no reviewer agent keeps the old behaviour rather than inventing one.
        const reviewerId = registry
          .list()
          .find(
            candidate =>
              candidate.id !== assigneeId &&
              /review/i.test(candidate.profile.title ?? "")
          )?.id;
        const task = tasks.create({
          title: input.title,
          requester: principals.resolve(input.identity).id,
          ...(assigneeId !== undefined ? { assigneeId } : {}),
          ...(reviewerId !== undefined ? { reviewerId } : {}),
          conversation: conversationIdFor(input.threadKey ?? input.chatKey),
        });
        return task?.id;
      },
      // Only when an operator said where this installation is reachable from a phone.
      // Guessing (the bind address, a container's hostname) would put a link in a chat
      // that opens nothing, which is worse than no link.
      urlFor: taskId => {
        const base = process.env.AGENTBOX_PUBLIC_URL;
        return base === undefined || base === ""
          ? undefined
          : `${base.replace(/\/+$/, "")}/?task=${encodeURIComponent(taskId)}`;
      },
      started: taskId => {
        orchestrator.tasks?.update(taskId, { status: "doing" }, "channel");
      },
      closed: (taskId, outcome, note) => {
        orchestrator.tasks?.update(
          taskId,
          outcome === "done"
            ? { status: "done" }
            : { status: "blocked", note: `failed: ${note ?? "unknown"}` },
          "channel"
        );
      },
    },
    // A file dropped in the chat lands in that chat's inbox on the box, under a name
    // that never overwrites: a second report.pdf becomes report-2.pdf, because the
    // first one may be exactly what the agent is reading.
    receiveFiles: async (chatKey, files) => {
      const client = orchestrator.boxClient();
      if (client === undefined) return undefined;
      const dir = `${WORK_DIR}/chats/${conversationIdFor(chatKey)}/inbox`;
      await client.exec(`mkdir -p '${dir}'`);
      let existing: Set<string>;
      try {
        existing = new Set((await client.listDir(dir)).entries.map(entry => entry.name));
      } catch {
        existing = new Set();
      }
      const saved: string[] = [];
      for (const file of files) {
        const clean = file.name.replace(/[/\\\0]/g, "_").slice(0, 120) || "file";
        let name = clean;
        for (let n = 2; existing.has(name); n++) {
          const dot = clean.lastIndexOf(".");
          name = dot > 0 ? `${clean.slice(0, dot)}-${n}${clean.slice(dot)}` : `${clean}-${n}`;
        }
        existing.add(name);
        await client.uploadFile(`${dir}/${name}`, file.base64);
        saved.push(`inbox/${name}`);
      }
      return saved;
    },
    // The chat's outbox on the box: list, download, and — once pushed — move to
    // sent/, so nothing is delivered twice and nothing undelivered is lost. A chat
    // that never used files has no directory, and that is the cheap ordinary case.
    collectOutbox: async chatKey => {
      const client = orchestrator.boxClient();
      if (client === undefined) return [];
      const dir = `${WORK_DIR}/chats/${conversationIdFor(chatKey)}/outbox`;
      let entries: { name: string; type: string; size: number }[];
      try {
        entries = (await client.listDir(dir)).entries;
      } catch {
        return [];
      }
      const files: { name: string; base64: string }[] = [];
      for (const entry of entries) {
        if (entry.type !== "file") continue;
        if (entry.size > 25 * 1024 * 1024) {
          log(`outbox: ${entry.name} skipped (${entry.size} bytes is past the 25MB cap)`);
          continue;
        }
        try {
          files.push({ name: entry.name, base64: (await client.downloadFile(`${dir}/${entry.name}`)).base64 });
        } catch (error) {
          log(`outbox: could not read ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Smallest first: if a push dies midway, the cheap ones made it out.
      return files.sort((a, b) => a.base64.length - b.base64.length);
    },
    outboxDelivered: async (chatKey, names) => {
      const client = orchestrator.boxClient();
      if (client === undefined) return;
      const dir = `${WORK_DIR}/chats/${conversationIdFor(chatKey)}/outbox`;
      const quoted = names.map(name => `'${name.replace(/'/g, `'\\''`)}'`).join(" ");
      await client.exec(`mkdir -p '${dir}/../sent' && cd '${dir}' && mv -- ${quoted} ../sent/`);
    },
    // The desktop as it is right now, for "屏幕" and for the finished-task poster.
    // Captured with the agent's own owner token, the same proof a turn presents; an
    // agent whose desktop never started answers undefined and the chat is told so.
    screenshot: async agentName => {
      const client = orchestrator.boxClient();
      if (client === undefined) return undefined;
      const agent =
        agentName !== undefined ? registry.resolve(agentName) : registry.list()[0];
      if (agent === undefined) return undefined;
      const result = await client.computer([{ action: "screenshot" }], {
        display: registry.displayIndexFor(agent.id),
        owner: registry.boxOwnerTokenFor(agent.id),
      });
      return result.screenshot;
    },
    // What a queued acknowledgement says: the running turn counts as one ahead, plus
    // whatever is already waiting in this chat's lane. An unknown agent name answers
    // zero — the ask that follows throws the message worth relaying.
    ahead: (agentName, chatKey) => {
      try {
        const agent =
          agentName !== undefined ? registry.resolve(agentName) : registry.list()[0];
        if (agent === undefined) return 0;
        const conversation = conversationIdFor(chatKey);
        return (
          (orchestrator.bus.isActive(agent.id, conversation) ? 1 : 0) +
          orchestrator.bus.queuedCount(agent.id, conversation)
        );
      } catch {
        return 0;
      }
    },
  });
  {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    channels.register(
      new TelegramChannel(telegramToken ?? "", line => log(line)),
      telegramToken !== undefined,
      telegramToken !== undefined ? "starting" : "set TELEGRAM_BOT_TOKEN"
    );
    const feishuId = process.env.FEISHU_APP_ID;
    const feishuSecret = process.env.FEISHU_APP_SECRET;
    channels.register(
      new FeishuChannel(feishuId ?? "", feishuSecret ?? "", line => log(line), ingress),
      feishuId !== undefined && feishuSecret !== undefined,
      feishuId !== undefined && feishuSecret !== undefined
        ? "starting"
        : "set FEISHU_APP_ID and FEISHU_APP_SECRET"
    );
    const dingId = process.env.DINGTALK_CLIENT_ID;
    const dingSecret = process.env.DINGTALK_CLIENT_SECRET;
    channels.register(
      new DingTalkChannel(dingId ?? "", dingSecret ?? "", line => log(line)),
      dingId !== undefined && dingSecret !== undefined,
      dingId !== undefined && dingSecret !== undefined
        ? "starting"
        : "set DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET"
    );
  }
  chats = channels;
  channels.start();

  // Answers that were owed when this process last stopped.
  //
  // A channel request is answered by an awaited promise, and that promise is the only
  // thing that knows where the answer goes. It dies with the process — while the turn is
  // recovered from the ledger and runs to completion, so the work is done, the money is
  // spent, and the reply is delivered nowhere. Observed: t12 sat in `doing` with its turn
  // finished half an hour earlier and its answer sitting unread in the transcript.
  //
  // Nothing about the reply was stored. It is recovered the same way the live path builds
  // it — everything the agent said past the recorded index — because the transcript is
  // already durable and the promise was never where the answer lived.
  void (async () => {
    for (const owed of deliveries.pending()) {
      let reply = "";
      try {
        reply = orchestrator.replySince(owed.agentId, owed.before, owed.conversation).trim();
      } catch {
        // A transcript that cannot be read is a delivery that cannot be recovered; it
        // falls through to the rescue below rather than holding up the others.
      }
      if (reply === "") continue;
      log(`delivering an answer owed since ${owed.at} to ${owed.chatKey}`);
      const late =
        `This finished while I was restarting, so it is arriving late:\n\n${reply}`;
      try {
        await channels.pushToChat(owed.chatKey, late);
        // Closed by the id the request carried. It matters: the sweep below would
        // otherwise reopen a task whose answer had just been handed over and ask the
        // person to request it again.
        if (owed.taskId !== undefined) {
          orchestrator.tasks?.update(
            owed.taskId,
            { status: "done", note: "answered after a restart" },
            "restart"
          );
        }
        deliveries.close(owed.id);
      } catch {
        // Left owed, so the next start tries again. A delivery that is dropped because
        // the chat was briefly unreachable is the bug this exists to fix.
      }
    }

    // Whatever is still owed had no answer to recover — the turn never got far enough.
    // Those are the ones the person has to be told about, because there is nothing to
    // hand over and re-running may repeat work that already had effects.
    if (orchestrator.tasks !== undefined) {
      const rescued = rescueStuck(orchestrator.tasks, new Set());
      for (const stuck of rescued) {
        log(`rescued ${stuck.task.id}: ${stuck.task.title}`);
        const message = rescueMessage(stuck);
        broadcast({ type: "error", message });
        if (stuck.conversation !== undefined) {
          void channels.pushToChat(stuck.conversation, message).catch(() => {});
        }
      }
    }
  })();

  // The standing digests: checked a few times an hour, sent once per chat per day.
  // The sent-marker is in memory, so the one failure mode is a duplicate digest after
  // a restart in the same hour — the cheap side of that trade.
  const digestsSent = new Map<string, string>();
  const digestTimer = setInterval(() => {
    const configured = loadConfig().digests ?? {};
    const now = new Date();
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    for (const [chatKey, hour] of Object.entries(configured)) {
      if (now.getHours() !== hour || digestsSent.get(chatKey) === today) continue;
      digestsSent.set(chatKey, today);
      void channels.pushToChat(chatKey, digestFor(chatKey));
    }
  }, 10 * 60_000);
  digestTimer.unref?.();

  // An upgrade nobody knows about is an upgrade that does not happen. This tells the
  // people who may decide, and deliberately does not act: a web server that recreates the
  // box underneath the people using it is a worse surprise than an out-of-date image.
  // Performing an upgrade is `agentbox box upgrade`, which is safe to put on a timer.
  let upgradeToldAbout: string | undefined;
  const upgradeTimer = setInterval(() => {
    void (async () => {
      try {
        const availability = await provisioner.upgradeAvailable?.();
        if (availability?.available !== true) return;
        // Once per image, not once per check: a notice repeated every six hours is one
        // people filter out, including the time it matters.
        if (upgradeToldAbout === availability.built) return;

        const box = await provisioner.connect().catch(() => undefined);
        const findings = box
          ? await preflight(box)
          : { runningJobs: [], strayFiles: [], moreStrayFiles: false, unknown: "the box could not be reached" };
        const decision = decideUpgrade({
          preflight: findings,
          watching: clients.size,
          ...(loadConfig().upgradeHour !== undefined
            ? { quietHour: loadConfig().upgradeHour as number }
            : {}),
          hour: new Date().getHours(),
        });
        // "wait" and "go" are for whatever performs upgrades to act on; there is nothing
        // here a person needs to read, and saying it anyway is how notices get ignored.
        if (decision.action !== "ask" && decision.action !== "announce") return;

        upgradeToldAbout = availability.built;
        const text = upgradeMessage(decision, "Your box");
        broadcast({ type: "error", message: text });
        for (const { adapter, identity } of adminRecipients(principals.list())) {
          void channels.push(adapter, identity, text);
        }
        log(`upgrade available (${availability.running} -> ${availability.built}): ${decision.action}`);
      } catch {
        // Never the reason the server falls over: this is a notice about housekeeping.
      }
    })();
  }, 6 * 60 * 60_000);
  upgradeTimer.unref?.();

  orchestrator.policy.onApprovalRequested = approval => {
    announceApproval(approval);
    // Whoever asked from a phone is the person who can unblock this — and can now do
    // it with a one-word reply, without opening the app.
    channels.notifyApproval(
      approval.agentId,
      approval.id,
      approval.agentName,
      approval.description
    );
  };

  // The box dying is exactly the event nobody is looking at the page for. A light
  // health probe, and only the ok→gone *transition* is announced — a box that stays
  // down does not deserve a notification a minute.
  let boxWasHealthy = false;
  const boxWatch = setInterval(() => {
    void (async () => {
      const client = orchestrator.boxClient();
      if (client !== undefined) {
        try {
          await client.health();
          boxWasHealthy = true;
          return;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          // Written every time, not only on the transition: the page reads this, and a
          // value set once at startup is a claim about one moment presented as the
          // present. The *announcement* stays edge-triggered — a box that stays down
          // does not deserve a notification a minute.
          box = { connected: false, detail };
          if (boxWasHealthy) {
            boxWasHealthy = false;
            log(`box stopped answering: ${detail}`);
            broadcast({ type: "error", message: `The box stopped answering: ${detail}` });
          }
        }
      }

      // Down, or never up. Try again — and try *resolving* it again rather than
      // retrying the address we already have, because a box that was updated or
      // recreated comes back on a different published port. Watching without
      // reconnecting is what made "restart the app" the recovery for an event the
      // product's own promise says should need no attention.
      const attempt = await orchestrator.connectBox();
      box = attempt;
      if (!attempt.connected) return;
      boxWasHealthy = true;
      log(`box reachable again: ${attempt.detail}`);
      broadcast({ type: "error", message: `The box is back: ${attempt.detail}` });
      // Desktops are brought up on demand and remembered; a box that was replaced has
      // none of them, and a remembered one would be a screen that never appears.
      void orchestrator.ensureAllDesktops().catch(() => {});
    })();
    // Configurable only so a test can watch a recovery without waiting half a minute
    // for each tick; nothing in production has a reason to change it.
  }, envNumber("AGENTBOX_BOX_WATCH_MS", 30_000));
  boxWatch.unref?.();

  // Backups on a timer, off unless asked for. The state this protects is the only part of the
  // system that cannot be rebuilt, and the previous instruction — stop the box, then `cp -a` —
  // required both stopping and remembering, so it did not happen.
  const backupHours = envNumber("AGENTBOX_BACKUP_HOURS", 0);
  const backups =
    backupHours > 0
      ? new BackupSchedule({ intervalMs: backupHours * 3_600_000, log: line => log(line) })
      : undefined;
  if (backups !== undefined) {
    // One at startup, so a fresh deployment has a copy before it has run anything, rather than
    // after the first interval it may not survive.
    backups.once();
    backups.start();
    log(`backing up every ${backupHours}h to ${backupRoot()}`);
  }

  // Mutable: the UI can bring the box up after this server started without one.
  let box = await orchestrator.connectBox();
  log(box.connected ? `box: ${box.detail}` : `box: unavailable — ${box.detail}`);

  // Recovery happens only now, after the box is connected — a recovered turn captures whatever box
  // the orchestrator holds when it is built, and a turn that started before the box was up would run
  // without shell, files, or a desktop and could finish or fail before the box ever arrived. The
  // inbox first, then interrupted turns: a turn already running is further along than a message only
  // accepted, and they run in the order queued.
  const restored = orchestrator.bus.recover();
  if (restored > 0) {
    log(
      `resumed ${restored} message${restored === 1 ? "" : "s"} accepted before the last restart ` +
        `and never started`
    );
  }
  const picked = orchestrator.resumeInterrupted();
  if (picked.resumed > 0) {
    log(`picking up ${picked.resumed} turn${picked.resumed === 1 ? "" : "s"} interrupted by a restart`);
  }
  if (picked.abandoned > 0) {
    log(
      `${picked.abandoned} interrupted turn${picked.abandoned === 1 ? "" : "s"} not picked up again ` +
        `after repeated failures; said so in the transcript`
    );
  }

  // Every agent's desktop, up front: the point of this UI is that a person can
  // take over any of them at any moment, which cannot wait on that agent's first
  // turn. Costs a few seconds at startup and nothing after.
  if (box.connected) {
    const boxClient = orchestrator.boxClient();
    if (boxClient) void seedStarterSkills(boxClient, line => log(line));
    const desktops = await orchestrator.ensureAllDesktops();
    for (const desktop of desktops) {
      log(
        desktop.index === undefined
          ? `desktop for ${desktop.name}: failed to start`
          : `desktop for ${desktop.name}: :${desktop.index}`
      );
    }
  }


  /**
   * Each agent's desktop is proxied under this server's own origin.
   *
   * Two reasons it goes through here rather than being linked directly. The
   * desktops live on in-container ports that are never published — boxd proxies
   * them — so this is the only route to them. And a published port would be
   * ephemeral, changing on every recreate and silently blanking any open tab.
   *
   * /desktop/<index>/... is the stable path; the browser only ever sees indices.
   *
   * Resolved per request rather than once at startup, and re-resolved when a proxy
   * attempt fails. Docker assigns boxd a fresh host port on every `box up --recreate`,
   * so a cached one turns every desktop into a 502 for the rest of the process's life —
   * which is what happened three times while building this: the box was rebuilt, the UI
   * kept pointing at a dead port, and the only fix anyone knew was restarting the UI.
   * The lookup is a `docker port` call, cached for a few seconds so a page load's worth
   * of asset requests does not shell out for each one.
   */
  interface Origin {
    host: string;
    port: number;
    token: string;
  }
  let cachedOrigin: { value: Origin | undefined; at: number } | undefined;
  const ORIGIN_TTL_MS = 5000;

  async function resolveBoxdOrigin(force = false): Promise<Origin | undefined> {
    if (!force && cachedOrigin && Date.now() - cachedOrigin.at < ORIGIN_TTL_MS) {
      return cachedOrigin.value;
    }
    let value: Origin | undefined;
    try {
      const endpoint = await provisioner.endpoint();
      if (endpoint) {
        const url = new URL(endpoint.baseUrl);
        value = {
          host: url.hostname,
          port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
          token: endpoint.token,
        };
      }
    } catch {
      value = undefined;
    }
    cachedOrigin = { value, at: Date.now() };
    return value;
  }

  /** Rewrites /desktop/<index>/<rest> to boxd's /vnc/<index>/<rest>. */
  async function proxyDesktop(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    retried = false
  ): Promise<void> {
    const origin = await resolveBoxdOrigin(retried);
    if (!origin) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("The box is not available. Start it with `agentbox box up`.");
      return;
    }

    const upstream = httpRequest(
      {
        host: origin.host,
        port: origin.port,
        method: req.method,
        path,
        headers: {
          ...req.headers,
          host: `${origin.host}:${origin.port}`,
          // boxd requires the token on everything but /health and the VNC stream.
          authorization: `Bearer ${origin.token}`,
        },
      },
      response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      }
    );

    upstream.on("error", error => {
      // A recreated box means a new host port. One retry with a forced lookup turns
      // that from a permanent 502 into a hiccup.
      if (!retried && !res.headersSent) {
        void proxyDesktop(req, res, path, true);
        return;
      }
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`Cannot reach the box desktop: ${error.message}`);
      } else {
        res.end();
      }
    });

    req.pipe(upstream);
  }

  function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
    const payload = type === "application/json" ? JSON.stringify(body) : String(body);
    res.writeHead(status, {
      "content-type": type === "application/json" ? type : `${type}; charset=utf-8`,
      "content-length": Buffer.byteLength(payload),
      // The page is regenerated on every start; a cached copy would hide changes.
      "cache-control": "no-store",
    });
    res.end(payload);
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > 1_000_000) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  }

  /** Signs web sessions; set from the resolved UI token before the server listens. */
  let sessionSecret = "";

  /**
   * What an outside agent may do here, and nothing more.
   *
   * Narrow on purpose, and the narrowness is the product: a persistent computer with a
   * desktop, and a team that can be given work and asked about later. Not our memory,
   * not the filesystem wholesale, not the ability to reconfigure the installation —
   * those belong to the people who live here, and an external agent borrowing a
   * workforce has no business with them.
   *
   * Everything routes through the same objects a person's request does, which is what
   * makes the attribution real rather than decorative: the task lands on the same
   * board, the spend lands on the same principal, and a dangerous action raises the
   * same approval card to the same phone.
   */
  const mcpServerTools = (): McpServerTool[] => [
    {
      name: "assign_task",
      description:
        "Hand a piece of work to this installation's team of agents. They have a " +
        "persistent Linux box with a desktop and a browser, so this is for work that " +
        "needs a computer of its own or outlives your session. Returns a task id; ask " +
        "about it later with task_status rather than waiting.",
      inputSchema: {
        type: "object",
        properties: {
          brief: { type: "string", description: "The whole request, self-contained." },
          agent: { type: "string", description: "Which agent, by name. Omit for the coordinator." },
        },
        required: ["brief"],
      },
      readOnly: false,
      run: async (input, principalId) => {
        const brief = String(input.brief ?? "").trim();
        if (brief === "") throw new Error("A task needs a brief.");
        const agentName = typeof input.agent === "string" ? input.agent : undefined;
        const agent =
          agentName !== undefined
            ? registry.resolve(agentName)
            : (registry.list()[0] ?? orchestrator.ensureDefaultAgent());
        const task = orchestrator.tasks?.create({
          title: brief.split("\n", 1)[0] ?? brief,
          description: brief,
          requester: principalId,
          assigneeId: agent.id,
        });
        // Not awaited: the caller gets an id now and asks later, which is the only
        // shape that works for work measured in minutes.
        void orchestrator
          .prompt(agent.id, brief, { userId: principalId }, { lane: "agent" })
          .catch(error => log(`mcp task failed: ${error instanceof Error ? error.message : error}`));
        return task === undefined
          ? `${agent.profile.name} is on it.`
          : `${task.id} — ${agent.profile.name} is on it. Ask task_status about ${task.id}.`;
      },
    },
    {
      name: "task_status",
      description:
        "How a task is going: its state, who has it, and every move anybody made on " +
        "it. With no id, the tasks you asked for that are still open.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string", description: "A task id like t42." } },
      },
      readOnly: true,
      run: async (input, principalId) => {
        const board = orchestrator.tasks;
        if (board === undefined) return "This installation has no task board.";
        const nameOf = (id: string) => registry.tryGet(id)?.profile.name ?? id;
        const id = typeof input.task_id === "string" ? input.task_id : "";
        if (id === "") {
          const mine = board
            .list()
            .filter(task => task.requester === principalId && isLive(task.status));
          return mine.length === 0
            ? "Nothing of yours is still open."
            : mine.map(task => describeTask(task, nameOf)).join("\n");
        }
        const task = board.get(id);
        if (task === undefined) return `No task ${id}.`;
        // Anyone with a token may read any task: the board is the team's shared record,
        // and hiding a colleague's row from a colleague's agent would be theatre.
        const history = task.history
          .map(change => `  ${change.at} ${nameOf(change.by)} ${change.status ?? ""} ${change.note ?? ""}`.trimEnd())
          .join("\n");
        return `${describeTask(task, nameOf)}\n${history}`;
      },
    },
    {
      name: "list_agents",
      description: "Who is on this installation's team, and what each is for.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      run: async () =>
        registry
          .list()
          .map(agent => `${agent.profile.name}${agent.profile.title ? ` (${agent.profile.title})` : ""} — ${agent.profile.description.slice(0, 160)}`)
          .join("\n") || "No agents yet.",
    },
    {
      name: "run_on_box",
      description:
        "Run a shell command on this installation's box — a persistent Linux machine " +
        "with a real filesystem, where installed tools stay installed and files " +
        "outlive your session. Not your machine and not a scratch container.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "Defaults to the work directory." },
        },
        required: ["command"],
      },
      readOnly: false,
      run: async (input, principalId) => {
        const client = orchestrator.boxClient();
        if (client === undefined) throw new Error("No box is running on this installation.");
        const command = String(input.command ?? "").trim();
        if (command === "") throw new Error("Nothing to run.");
        // The same gate a resident agent's shell passes, judged under the caller's own
        // name — so an outside agent cannot do what the person holding its token may
        // not, and a dangerous command raises a card to that person's phone.
        const decision = orchestrator.policy.check({
          kind: "tool",
          agentId: `mcp:${principalId}`,
          agentName: principals.resolve(principalId).name,
          tool: "bash",
          input: { command },
        });
        if (!decision.allow) throw new Error(decision.reason);
        const result = await client.exec(command, {
          cwd: typeof input.cwd === "string" ? input.cwd : WORK_DIR,
          timeoutMs: 120_000,
        });
        return [
          `exit code: ${result.exit_code}`,
          result.stdout.trim() ? `stdout:\n${result.stdout}` : "",
          result.stderr.trim() ? `stderr:\n${result.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      },
    },
    {
      name: "box_screenshot",
      description:
        "See the box's desktop as it is now. Useful after asking the team for " +
        "something visual, or before driving it yourself.",
      inputSchema: {
        type: "object",
        properties: { agent: { type: "string", description: "Whose desktop. Defaults to the first." } },
      },
      readOnly: true,
      run: async input => {
        const client = orchestrator.boxClient();
        if (client === undefined) throw new Error("No box is running on this installation.");
        const agent =
          typeof input.agent === "string" ? registry.resolve(input.agent) : registry.list()[0];
        if (agent === undefined) throw new Error("No agents on this installation.");
        const shot = await client.computer([{ action: "screenshot" }], {
          display: registry.displayIndexFor(agent.id),
          owner: registry.boxOwnerTokenFor(agent.id),
        });
        // A path rather than the bytes: this bridge carries text, and a screenshot the
        // caller can fetch beats a megabyte of base64 it did not ask for.
        const path = `${WORK_DIR}/.mcp-shots/${agent.id}-${Date.now()}.webp`;
        await client.exec(`mkdir -p ${WORK_DIR}/.mcp-shots`);
        await client.uploadFile(path, shot.screenshot);
        return `Saved the current desktop of ${agent.profile.name} to ${path}.`;
      },
    },
  ];

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;

      const decision = authorize(
        { token, host },
        {
          authorization: req.headers.authorization,
          cookie: req.headers.cookie,
          query: url.searchParams.get("token"),
        }
      );
      // The door itself is before the gate, and must be: a person holding an invite
      // code has no token yet, and a sign-in page that requires being signed in is a
      // locked door with the key inside. These two routes are the only exemption, and
      // the code is what authenticates them.
      if (route === "GET /login") {
        send(res, 200, LOGIN_HTML, "text/html");
        return;
      }
      // The side door, before the UI's gate and deliberately so: it carries its own
      // credential, issued to a person, and the UI token is not it.
      if (
        await handleMcpRequest(req, res, {
          tools: mcpServerTools(),
          principalFor: presented => principalForToken(presented, mcpTokens),
          log: line => log(line),
        })
      ) {
        return;
      }
      if (!decision.allow && route !== "POST /api/login") {
        // No WWW-Authenticate: a browser prompt would be the wrong shape for this, and the
        // token belongs in the URL once rather than typed into a dialog.
        send(res, 401, {
          error:
            "This UI needs a token. Open it with ?token=… or send an Authorization: Bearer header.",
        });
        return;
      }
      if ("setCookie" in decision && decision.setCookie) {
        // Set before anything else writes headers, so the iframe and video requests that
        // follow this page load are already authenticated.
        res.setHeader("set-cookie", decision.setCookie);
      }

      // Who this is, read once and in one place. `decision.allow` is passed rather than re-derived,
      // so identity cannot be trusted on a request that authentication did not accept.
      //
      // Two identity paths, in order of authority: a gateway that vouches for someone
      // (headers, the deployed shape), then a web session somebody redeemed an invite
      // code for. Both are only read on an authorised request, and the second is signed
      // by a key derived from the token that authorised it.
      const gatewayCaller = callerOf(req.headers, decision.allow);
      const webIdentity = decision.allow
        ? readSession(parseCookies(req.headers.cookie).get(SESSION_COOKIE), sessionSecret)
        : undefined;
      const caller =
        gatewayCaller.userId === undefined && webIdentity !== undefined
          ? { ...gatewayCaller, userId: webIdentity }
          : gatewayCaller;

      /**
       * Refuses a mutating request the caller may not make, and says which role would allow it.
       *
       * Returns true when it has already answered, so a handler reads as one line rather than an
       * `if` nest. Every route that changes something calls this — a check per handler is how one
       * handler ends up missing it.
       */
      const refused = (agentId?: string): boolean => {
        // Whoever the session says this is, their authority is the roster's answer —
        // not the gateway header's, which is absent here and therefore reads as the
        // direct operator. Identity arrived through the session and authority has to
        // travel with it, or a viewer who signed in is a viewer in name only.
        const known: Caller =
          caller.userId !== undefined && !roleAtLeast(principals.roleOf(caller.userId), "driver")
            ? { ...caller, role: "viewer" }
            : caller;
        const agent = agentId === undefined ? undefined : registry.tryGet(agentId);
        const reason = refusalToDrive(known, agent?.profile);
        if (reason === undefined) return false;
        send(res, 403, { error: reason });
        return true;
      };

      /**
       * Refuses a request the caller's role is too low for.
       *
       * The web token holder is the machine's operator — they run it, they are admin;
       * a gateway that asserts a userId resolves that identity through the roster. So
       * the local UI is unrestricted (as it always was) while a channel-authenticated
       * or gateway user is held to their role.
       */
      const refusedRole = (need: Role): boolean => {
        const role: Role =
          caller.userId === undefined ? "admin" : principals.roleOf(caller.userId);
        if (roleAtLeast(role, need)) return false;
        send(res, 403, {
          error: `This needs the ${need} role; you are ${role}. Ask an admin.`,
        });
        return true;
      };

      try {
        if (route === "GET /") {
          send(res, 200, APP_HTML, "text/html");
          return;
        }

        // noVNC and its assets. `path` tells noVNC to open its socket under the
        // same prefix, so the whole desktop lives on this origin.
        if (url.pathname.startsWith("/desktop/")) {
          // Same choice as the upgrade: the page and the socket it opens must come from the same
          // stack, or a viewer would be served a page pointing at a stream they are refused.
          const upstream = desktopUpstreamPath(
            url.pathname,
            url.search,
            mayDrive(caller)
          );
          if (!upstream) {
            send(res, 404, { error: `Not a desktop path: ${url.pathname}` });
            return;
          }
          await proxyDesktop(req, res, upstream);
          return;
        }

        // The Markdown renderer, read from node_modules. Served from here rather than
        // a CDN so the UI works with no network and stays on the locked version.
        if (route === "GET /vendor/markdown-it.js") {
          try {
            vendorScript ??= readFileSync(vendorPath());
            res.writeHead(200, {
              "content-type": "application/javascript; charset=utf-8",
              "content-length": vendorScript.length,
              "cache-control": "no-store",
            });
            res.end(vendorScript);
          } catch (error) {
            // The page falls back to plain text, so say what is missing and carry on.
            const detail = error instanceof Error ? error.message : String(error);
            log(`markdown-it is unavailable: ${detail}`);
            send(res, 404, { error: detail });
          }
          return;
        }

        // The IBM Plex faces the page's @font-face rules point at, from the repo's
        // assets directory. Absent is fine — font-display: swap and the stacks fall
        // back to system fonts — so a deployment without the directory degrades
        // quietly instead of breaking the page. The name is allowlisted by shape,
        // which is what keeps this from being a file server.
        if (url.pathname.startsWith("/assets/fonts/")) {
          const name = url.pathname.slice("/assets/fonts/".length);
          if (!/^[A-Za-z0-9-]+\.woff2$/.test(name)) {
            send(res, 404, { error: "not a font" });
            return;
          }
          try {
            let font = fontCache.get(name);
            if (font === undefined) {
              const dir =
                process.env.AGENTBOX_ASSETS_DIR ??
                fileURLToPath(new URL("../../assets/fonts", import.meta.url));
              font = readFileSync(join(dir, name));
              fontCache.set(name, font);
            }
            res.writeHead(200, {
              "content-type": "font/woff2",
              "content-length": font.length,
              // Unlike the page, a font file never changes under the same name.
              "cache-control": "public, max-age=86400",
            });
            res.end(font);
          } catch {
            send(res, 404, { error: `${name} is not present on this deployment` });
          }
          return;
        }

        // Recording. The video streams through this server for the same reason the
        // desktop does: boxd's port is not something the browser should know about.
        if (route === "GET /recording") {
          const name = url.searchParams.get("name") ?? "";
          await proxyDesktop(
            req,
            res,
            `/recordings/file?name=${encodeURIComponent(name)}`
          );
          return;
        }

        // The clipboard, both directions. A VNC canvas is not a text field: without
        // this, anything the user wants in the box has to be retyped by hand, and
        // anything an agent leaves on the clipboard is stuck there.
        if (route === "POST /api/clipboard") {
          if (refused()) return;
          const body = await readJson(req);
          const agentId = String(body.agent ?? "");
          const client = orchestrator.boxClient();

          if (!client) {
            send(res, 503, { error: "The box is not available." });
            return;
          }
          if (!registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }

          const index = registry.displayIndexFor(agentId);
          try {
            // Text present means write, absent means read: one route, because the two
            // are the same operation from the page's point of view.
            const result =
              typeof body.text === "string"
                ? await client.writeClipboard(body.text, index)
                : await client.readClipboard(index);
            send(res, 200, result);
          } catch (error) {
            send(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }

        // What has been spent. Shaped for a collector that remembers an offset — ?since=<seq> —
        // which is also what the UI uses to show a running total without re-reading everything.
        if (route === "GET /api/usage") {
          const since = Number(url.searchParams.get("since") ?? 0);
          const afterSeq = Number.isFinite(since) && since > 0 ? since : 0;
          send(res, 200, {
            records: orchestrator.usage.since(afterSeq, 500),
            totals: orchestrator.usage.totals(afterSeq),
          });
          return;
        }

        // ── policy: stopping a turn, and answering an approval ─────────────────────
        //
        // These are the only two things in this API a person does *to* a running agent rather than
        // with it, which is why they are POSTs with no body beyond an id: there is nothing to get
        // wrong, and nothing that reads as a normal instruction.
        if (route === "GET /api/policy") {
          send(res, 200, {
            pending: orchestrator.policy.pending(),
            standing: orchestrator.policy.standingGrants(),
            stopped: orchestrator.registry
              .list()
              .filter(agent => orchestrator.policy.isStopped(agent.id))
              .map(agent => agent.id),
          });
          return;
        }

        // The task board: work as an object. Reading is open to any session; moving
        // things needs the driver role, same as prompting — a board a viewer can
        // rearrange is not a record of anything.
        // Who the browser is, for the page's own header. Deliberately readable by any
        // authorised request: it says nothing the caller does not already know.
        if (route === "GET /api/me") {
          const principal =
            caller.userId === undefined ? undefined : principals.resolve(caller.userId);
          send(res, 200, {
            identity: caller.userId ?? null,
            name: principal?.name ?? null,
            // No identity at all is the direct operator: the token holder, unrestricted,
            // exactly as this UI has always behaved.
            role: caller.userId === undefined ? "admin" : (principal?.role ?? "viewer"),
          });
          return;
        }

        // Redeeming an invite code in a browser: the same code the chat's `bind` takes,
        // because one code for two surfaces is the whole point — a person the owner
        // invited can arrive either way and be the same principal either way.
        if (route === "POST /api/login") {
          const body = await readJson(req);
          const code = String(body.code ?? "").trim().toUpperCase();
          const invite = invites.get(code);
          if (invite === undefined || invite.expiresAt < Date.now()) {
            invites.delete(code);
            send(res, 400, {
              error: "That code is not live — codes last 15 minutes and work once.",
            });
            return;
          }
          invites.delete(code);
          const roster = principals.list();
          const existing =
            invite.principalId !== undefined
              ? roster.find(person => person.id === invite.principalId)
              : undefined;
          const identity = newWebIdentity();
          // Two cookies, because they answer different questions: the token says this
          // browser may reach the installation at all, the session says who it is. The
          // code delivers the first and mints the second; what the person may then *do*
          // is their roster role, checked on every request that changes something.
          const admit = [
            ...(token !== undefined
              ? [
                  `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; ` +
                    `Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`,
                ]
              : []),
            sessionCookie(identity, sessionSecret),
          ];
          if (existing !== undefined) {
            // A code made for somebody already known links this browser to them: same
            // human, second surface, one bill.
            existing.identities.push(identity);
            principals.save(roster);
            res.setHeader("set-cookie", admit);
            log(`web login: ${identity} linked to ${existing.name}`);
            send(res, 200, { name: existing.name, role: existing.role });
            return;
          }
          const name = String(body.name ?? "").trim().slice(0, 60);
          if (name === "") {
            send(res, 400, { error: "Say who you are, so your work has a name on it." });
            return;
          }
          roster.push({ id: identity, name, role: invite.role, identities: [identity] });
          principals.save(roster);
          res.setHeader("set-cookie", admit);
          log(`web login: ${name} joined as ${invite.role}`);
          send(res, 200, { name, role: invite.role });
          return;
        }

        if (route === "GET /api/tasks") {
          const board = orchestrator.tasks;
          send(res, 200, { tasks: board === undefined ? [] : board.list() });
          return;
        }

        if (route === "POST /api/tasks") {
          if (refused()) return;
          const board = orchestrator.tasks;
          if (board === undefined) {
            send(res, 503, { error: "No task board on this installation." });
            return;
          }
          const body = await readJson(req);
          const created = board.create({
            title: String(body.title ?? ""),
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            requester: caller.userId ?? "web",
            ...(typeof body.assigneeId === "string" && body.assigneeId !== ""
              ? { assigneeId: body.assigneeId }
              : {}),
            ...(typeof body.reviewerId === "string" && body.reviewerId !== ""
              ? { reviewerId: body.reviewerId }
              : {}),
          });
          if (created === undefined) {
            send(res, 400, { error: "A task needs a title." });
            return;
          }
          send(res, 200, { task: created });
          return;
        }

        if (route === "POST /api/tasks/update") {
          if (refused()) return;
          const board = orchestrator.tasks;
          if (board === undefined) {
            send(res, 503, { error: "No task board on this installation." });
            return;
          }
          const body = await readJson(req);
          const status = String(body.status ?? "");
          const updated = board.update(
            String(body.id ?? ""),
            {
              ...(isTaskStatus(status) ? { status } : {}),
              ...(typeof body.note === "string" && body.note.trim() !== ""
                ? { note: body.note }
                : {}),
              ...(typeof body.assigneeId === "string"
                ? { assigneeId: body.assigneeId === "" ? null : body.assigneeId }
                : {}),
            },
            caller.userId ?? "web"
          );
          if (updated === undefined) {
            send(res, 404, { error: `No task ${String(body.id ?? "")}.` });
            return;
          }
          send(res, 200, { task: updated.task, ...(updated.coerced ? { note: updated.coerced } : {}) });
          return;
        }

        // Scopes: named authority bundles (tools + secret grants). Admin only, because
        // a scope is who-may-do-what for every agent placed in it.
        if (route === "GET /api/scopes") {
          if (refusedRole("admin")) return;
          send(res, 200, { scopes: orchestrator.scopes?.list() ?? [], allTools: ALL_TOOLS });
          return;
        }

        if (route === "POST /api/scopes") {
          if (refusedRole("admin")) return;
          if (orchestrator.scopes === undefined) {
            send(res, 503, { error: "No scopes on this installation." });
            return;
          }
          const body = await readJson(req);
          if (!Array.isArray(body.scopes)) {
            send(res, 400, { error: "scopes must be an array" });
            return;
          }
          const scopes = (body.scopes as Record<string, unknown>[])
            .filter(s => typeof s.name === "string" && s.name.trim() !== "")
            .map(s => ({
              id: typeof s.id === "string" ? s.id : "",
              name: s.name as string,
              ...(Array.isArray(s.tools) ? { tools: (s.tools as unknown[]).filter((t): t is string => typeof t === "string") } : {}),
              secretIds: Array.isArray(s.secretIds)
                ? (s.secretIds as unknown[]).filter((x): x is string => typeof x === "string")
                : [],
              ...(Array.isArray(s.egressHosts) ? { egressHosts: (s.egressHosts as unknown[]).filter((h): h is string => typeof h === "string") } : {}),
              ...(typeof s.filesRoot === "string" ? { filesRoot: s.filesRoot } : {}),
            }));
          orchestrator.scopes.save(scopes);
          log(`scopes updated (${scopes.length})`);
          send(res, 200, { scopes: orchestrator.scopes.list() });
          return;
        }

        // The credential vault: names, descriptions and grants — never values. Admin
        // only, because a secret's grants are who-may-do-what.
        if (route === "GET /api/vault") {
          if (refusedRole("admin")) return;
          send(res, 200, { secrets: vault.list() });
          return;
        }

        if (route === "POST /api/vault") {
          if (refusedRole("admin")) return;
          const body = await readJson(req);
          const id = typeof body.id === "string" ? body.id.trim() : "";
          if (id === "") {
            send(res, 400, { error: "A secret needs an id (the environment variable name)." });
            return;
          }
          const grants: Grant[] = Array.isArray(body.grants)
            ? (body.grants as Record<string, unknown>[])
                .filter(g => typeof g.holder === "string" && g.holder !== "")
                .map(g => ({
                  holder: g.holder as string,
                  ...(typeof g.expiresAt === "string" && g.expiresAt !== ""
                    ? { expiresAt: g.expiresAt }
                    : {}),
                }))
            : [];
          vault.setSecret({
            id,
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(typeof body.value === "string" && body.value !== "" ? { value: body.value } : {}),
            grants,
          });
          log(`vault: saved secret ${id}`);
          send(res, 200, { secrets: vault.list() });
          return;
        }

        if (route === "POST /api/vault/remove") {
          if (refusedRole("admin")) return;
          const body = await readJson(req);
          vault.removeSecret(String(body.id ?? ""));
          send(res, 200, { secrets: vault.list() });
          return;
        }

        // The chat channels: which exist, which are running, and the people who may
        // use them. The roster is the access-control list now, not a flat allow list.
        // The bridges to other people's tools: what is running, and how much of every
        // agent's prompt each one is spending.
        // Tokens for the side door. Issued to a person, listed without their secrets,
        // and revocable one at a time — an IDE that no longer needs access should not
        // require rotating everybody's.
        if (route === "POST /api/mcp/tokens") {
          if (refusedRole("driver")) return;
          const body = await readJson(req);
          const owner = caller.userId ?? String(body.principalId ?? "");
          if (owner === "") {
            send(res, 400, { error: "A token belongs to a person; sign in or name one." });
            return;
          }
          const minted = mintMcpToken(owner, String(body.label ?? ""));
          mcpTokens.push(minted);
          log(`mcp token issued to ${owner} (${minted.label})`);
          // The only time the secret is ever returned: it is not stored anywhere it
          // could be read back, so a lost one is re-issued rather than recovered.
          send(res, 200, { token: minted.token, label: minted.label, createdAt: minted.createdAt });
          return;
        }

        if (route === "POST /api/mcp/tokens/revoke") {
          if (refusedRole("driver")) return;
          const body = await readJson(req);
          const at = mcpTokens.findIndex(
            entry =>
              entry.createdAt === String(body.createdAt ?? "") &&
              // A driver may only revoke their own; an admin may revoke anyone's.
              (entry.principalId === caller.userId ||
                roleAtLeast(
                  caller.userId === undefined ? "admin" : principals.roleOf(caller.userId),
                  "admin"
                ))
          );
          if (at < 0) {
            send(res, 404, { error: "No token of yours matches." });
            return;
          }
          mcpTokens.splice(at, 1);
          send(res, 200, { revoked: true });
          return;
        }

        if (route === "GET /api/mcp") {
          send(res, 200, {
            servers: orchestrator.mcp.statuses(),
            budget: TOOL_BUDGET_WARNING,
            // Never the secrets — only that they exist, whose they are, and when.
            tokens: mcpTokens.map(entry => ({
              label: entry.label,
              principalId: entry.principalId,
              createdAt: entry.createdAt,
              mine: entry.principalId === caller.userId,
            })),
          });
          return;
        }

        if (route === "GET /api/channels") {
          for (const [code, invite] of invites) {
            if (invite.expiresAt < Date.now()) invites.delete(code);
          }
          send(res, 200, {
            channels: channels.list(),
            principals: principals.list(),
            knocks: [...knocks.values()],
            invites: [...invites.entries()].map(([code, invite]) => ({
              code,
              role: invite.role,
              principalId: invite.principalId,
              expiresAt: invite.expiresAt,
            })),
          });
          return;
        }

        // A short-lived, single-use code. With a principalId it links a new identity
        // to an existing person (same human, second phone); without one it admits a
        // new person at the named role.
        if (route === "POST /api/channels/invite") {
          if (refusedRole("admin")) return;
          const body = await readJson(req);
          const role: Role =
            body.role === "admin" || body.role === "driver" || body.role === "viewer"
              ? (body.role as Role)
              : "driver";
          const code = newInviteCode();
          invites.set(code, {
            role,
            ...(typeof body.principalId === "string" && body.principalId !== ""
              ? { principalId: body.principalId }
              : {}),
            expiresAt: Date.now() + INVITE_TTL_MS,
          });
          log(`channel invite: ${code} (${role}) created`);
          send(res, 200, { code, role, expiresAt: Date.now() + INVITE_TTL_MS });
          return;
        }

        // One click on a knock. The person is told on the channel they knocked from,
        // because "approved silently" reads as "still ignored" from their side.
        if (route === "POST /api/channels/approve") {
          if (refusedRole("admin")) return;
          const body = await readJson(req);
          const identity = String(body.identity ?? "");
          const knock = knocks.get(identity);
          if (knock === undefined) {
            send(res, 404, { error: "Nobody with that id is waiting." });
            return;
          }
          const role: Role = body.role === "viewer" || body.role === "admin" ? body.role : "driver";
          const roster = principals.list();
          roster.push({ id: identity, name: knock.senderLabel, role, identities: [identity] });
          principals.save(roster);
          knocks.delete(identity);
          log(`channel approve: ${identity} (${knock.senderLabel}) as ${role}`);
          void channels.push(
            knock.channel,
            identity,
            `You're in as ${role}. Just say what you need done; @AgentName first picks who does it.`
          );
          send(res, 200, { principals: principals.list(), knocks: [...knocks.values()] });
          return;
        }

        if (route === "POST /api/channels/dismiss") {
          if (refusedRole("admin")) return;
          const body = await readJson(req);
          knocks.delete(String(body.identity ?? ""));
          send(res, 200, { knocks: [...knocks.values()] });
          return;
        }

        // Replaces the whole people roster. Only an admin edits who may do what —
        // otherwise a driver could promote themselves, which is the access-control
        // check being decorative.
        if (route === "POST /api/principals") {
          if (refusedRole("admin")) return;
          const body = await readJson(req);
          if (!Array.isArray(body.principals)) {
            send(res, 400, { error: "principals must be an array" });
            return;
          }
          const roster: Principal[] = [];
          for (const raw of body.principals as Record<string, unknown>[]) {
            const name = typeof raw.name === "string" ? raw.name.trim() : "";
            if (name === "") continue;
            const role: Role =
              raw.role === "admin" || raw.role === "driver" ? (raw.role as Role) : "viewer";
            const identities = Array.isArray(raw.identities)
              ? (raw.identities as unknown[]).filter((i): i is string => typeof i === "string")
              : [];
            roster.push({
              id: typeof raw.id === "string" && raw.id !== "" ? raw.id : (identities[0] ?? name),
              name,
              role,
              identities,
            });
          }
          principals.save(roster);
          log(`principals roster updated (${roster.length} people)`);
          send(res, 200, { principals: principals.list() });
          return;
        }

        // Ending a standing grant. The next identical action asks again.
        if (route === "POST /api/policy/revoke") {
          if (refused()) return;
          const body = await readJson(req);
          const revoked = orchestrator.policy.revokeStanding(String(body.fingerprint ?? ""));
          if (!revoked) {
            send(res, 404, { error: "No standing approval with that fingerprint." });
            return;
          }
          send(res, 200, { revoked: true });
          return;
        }

        // What a long task's progress actually looks like: the plan and the list, which survive
        // summarisation and so are the only state that is still true after an hour.
        // ── handing work over ──────────────────────────────────────────────────────
        //
        // The gap this closes: an agent would write a report to /home/box/work and say so, and that
        // was the end of it. A person had to open the VNC desktop, find a file manager, and read it
        // there — with no way to get it onto their own machine. The reference product solves this two
        // ways: pushing the file onto the user's actual disk through an agent running on their
        // machine, or attaching it to the message. We have no agent on their machine, so the browser
        // is the delivery mechanism, and these two routes are it.
        if (route === "GET /api/files") {
          const client = orchestrator.boxClient();
          if (!client) {
            send(res, 503, { error: "The box is not running." });
            return;
          }
          const dir = url.searchParams.get("dir") ?? WORK_DIR;
          // Confined here as well as in the daemon. Two checks rather than one because this is the
          // one reachable by anyone holding a UI token, including a viewer.
          if (!withinWork(dir)) {
            send(res, 403, { error: `Only ${WORK_DIR} and below can be browsed.` });
            return;
          }
          try {
            const listing = await client.listDir(dir);
            send(res, 200, listing);
          } catch (error) {
            send(res, 404, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }

        if (route === "GET /api/file") {
          const client = orchestrator.boxClient();
          if (!client) {
            send(res, 503, { error: "The box is not running." });
            return;
          }
          const path = url.searchParams.get("path") ?? "";
          if (!withinWork(path)) {
            send(res, 403, { error: `Only files under ${WORK_DIR} can be handed over.` });
            return;
          }
          try {
            const file = await client.downloadFile(path);
            const bytes = Buffer.from(file.base64, "base64");
            // `inline` so a browser shows what it can and downloads what it cannot; the filename is
            // still given, so "save as" produces the right name either way.
            const name = file.path.split("/").pop() ?? "file";
            res.writeHead(200, {
              "content-type": file.media_type,
              "content-length": bytes.length,
              "content-disposition": `${
                url.searchParams.get("download") === "1" ? "attachment" : "inline"
              }; filename="${name.replace(/["\\]/g, "")}"`,
              // Never cached: an agent rewrites its own output, and a stale copy would be read as
              // the current one.
              "cache-control": "no-store",
            });
            res.end(bytes);
          } catch (error) {
            send(res, 404, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }

        if (route === "POST /api/file") {
          // The other direction: a person hands the agent a document. Driving is required — a viewer
          // may read what the agents made and may not add to it.
          if (refused()) return;
          const client = orchestrator.boxClient();
          if (!client) {
            send(res, 503, { error: "The box is not running." });
            return;
          }
          const body = await readJson(req);
          const path = String(body.path ?? "");
          if (!withinWork(path)) {
            send(res, 403, { error: `Uploads only land under ${WORK_DIR}.` });
            return;
          }
          try {
            send(res, 200, await client.uploadFile(path, String(body.base64 ?? "")));
          } catch (error) {
            send(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }

        // For the composer's "/" menu. Names and descriptions only — the same index the agent gets,
        // for the same reason.
        if (route === "GET /api/skills") {
          const loaded = await orchestrator.skills.refresh();
          send(res, 200, {
            skills: loaded.skills.map(skill => ({
              slug: skill.slug,
              name: skill.name,
              description: skill.description,
              scope: skill.scope,
              path: skill.path,
            })),
            // Surfaced rather than swallowed: a skill with no description is invisible to the agent
            // while appearing to exist, and the person who wrote it is the only one who can fix it.
            problems: loaded.problems,
          });
          return;
        }

        if (route === "GET /api/progress") {
          const agentId = url.searchParams.get("agent") ?? "";
          if (!orchestrator.registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          // The plan and todos belong to a conversation now; the page shows whichever
          // thread it is viewing, defaulting to the team room.
          const conversation = url.searchParams.get("conversation") ?? MAIN_CONVERSATION;
          send(res, 200, orchestrator.registry.readDurableState(agentId, conversation));
          return;
        }

        if (route === "POST /api/stop") {
          const body = await readJson(req);
          const agentId = String(body.agent ?? "");
          if (refused(agentId)) return;
          if (!orchestrator.registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          // Recorded and effective immediately; the turn notices at its next round boundary. Not an
          // abort: cutting a request in flight would leave a tool call with no result, which the
          // next turn cannot replay.
          orchestrator.policy.stop(agentId);
          send(res, 202, { stopped: agentId });
          return;
        }

        if (route === "POST /api/approve" || route === "POST /api/deny") {
          // Answering an approval is driving: it is the moment a person authorises an action.
          if (refused()) return;
          const body = await readJson(req);
          const id = String(body.id ?? "");
          const scope =
            body.scope === "session" || body.scope === "always" ? body.scope : "once";
          const answered =
            route === "POST /api/approve"
              ? orchestrator.policy.grant(id, "user", scope)
              : orchestrator.policy.deny(id, "user", String(body.reason ?? "") || undefined);
          // 404 rather than an error for an unknown id: the usual cause is a second click or a page
          // left open, and neither deserves a failure.
          if (!answered) {
            send(res, 404, { error: "That approval is not waiting for an answer." });
            return;
          }
          send(res, 200, { id });
          return;
        }

        // ── settings: which provider, persisted ────────────────────────────────────
        //
        // The choice used to live only in the launch command, and a restart that forgot
        // the flag silently became a different company's model with a credential that
        // could not work. The file is the fix; this pair of routes is the interface to
        // it. A change takes effect at the next start — the orchestrator is built around
        // one provider, and swapping it under running turns would be a livelier bug than
        // a restart.
        if (route === "GET /api/config") {
          const config = loadConfig();
          send(res, 200, {
            current: describeProvider(provider),
            config: {
              provider: config.provider ?? null,
              model: config.model ?? null,
              baseUrl: config.baseUrl ?? null,
            },
            // The host door, and why it is or is not usable right now.
            hostExec: {
              enabled: hostRunner.enabled,
              cwd: config.hostExec?.cwd ?? null,
              // Present only after a restart with it on; the live runner is what an
              // agent would actually reach, so its reason is the honest one.
              unavailableReason: hostRunner.unavailableReason() ?? null,
            },
            // Whether a credential is present is worth showing; the credential is not.
            presets: providerNames().map(name => {
              const profile = resolveProvider(name);
              return {
                name,
                label: profile.label,
                model: profile.model,
                models: PRESET_MODELS[name] ?? [],
                keyEnv: profile.keyEnv,
                keyPresent:
                  process.env[profile.keyEnv] !== undefined ||
                  (profile.keyEnv === "ANTHROPIC_API_KEY" &&
                    process.env.ANTHROPIC_AUTH_TOKEN !== undefined),
              };
            }),
          });
          return;
        }

        if (route === "POST /api/config") {
          if (refusedRole("admin")) return;
          const body = await readJson(req);

          const providerValue = body.provider;
          if (
            typeof providerValue === "string" &&
            !providerNames().includes(providerValue.toLowerCase())
          ) {
            send(res, 400, {
              error: `Unknown provider "${providerValue}". Known: ${providerNames().join(", ")}.`,
            });
            return;
          }

          const field = (value: unknown): string | null | undefined =>
            value === null ? null : typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

          // The key is stored under the variable the chosen provider reads, and only
          // there: the UI cannot write arbitrary environment variables.
          const chosenName =
            (typeof providerValue === "string" ? providerValue.toLowerCase() : undefined) ??
            loadConfig().provider ??
            "anthropic";
          const key = field(body.key);
          // Host execution: a whole object or nothing. Enabling without a working
          // directory is refused here rather than saved and failed later.
          let hostExecChange: AgentboxConfigHostExec | null | undefined;
          if (body.hostExec !== undefined) {
            const incoming = (body.hostExec ?? {}) as { enabled?: unknown; cwd?: unknown };
            const enabled = incoming.enabled === true;
            const cwd = typeof incoming.cwd === "string" ? incoming.cwd.trim() : "";
            if (enabled && cwd === "") {
              send(res, 400, {
                error: "Turning host execution on needs a working directory for its commands.",
              });
              return;
            }
            hostExecChange =
              enabled || cwd !== "" ? { enabled, ...(cwd !== "" ? { cwd } : {}) } : null;
          }
          const path = saveConfig({
            provider: providerValue === null ? null : field(providerValue)?.toLowerCase(),
            model: body.model === null ? null : field(body.model),
            baseUrl: body.baseUrl === null ? null : field(body.baseUrl),
            ...(hostExecChange !== undefined ? { hostExec: hostExecChange } : {}),
            ...(key !== undefined && key !== null
              ? { env: { [resolveProvider(chosenName).keyEnv]: key } }
              : {}),
          });
          log(`config saved to ${path}`);
          send(res, 200, { saved: true, note: "Takes effect when the server restarts." });
          return;
        }

        // Brings the box up from the page — the first-run path, where telling someone
        // to go find a terminal is the product giving up. The docker output streams to
        // every connected page as events, because an image pull is minutes long and a
        // silent minutes-long button is indistinguishable from a broken one.
        if (route === "POST /api/box/up") {
          if (refused()) return;
          if (boxUpInFlight) {
            send(res, 409, { error: "The box is already being started." });
            return;
          }
          if (box.connected) {
            send(res, 200, { ok: true, detail: box.detail });
            return;
          }
          boxUpInFlight = true;
          send(res, 202, { starting: true });
          void (async () => {
            try {
              const manager = new BoxManager(defaultBoxConfig());
              await manager.up({
                onOutput: line => broadcast({ type: "box_setup", line }),
              });
              box = await orchestrator.connectBox();
              if (box.connected) {
                const desktops = await orchestrator.ensureAllDesktops();
                for (const desktop of desktops) {
                  log(`desktop for ${desktop.name}: ${desktop.index === undefined ? "failed" : `:${desktop.index}`}`);
                }
              }
              broadcast({
                type: "box_setup",
                line: box.connected ? `ready — ${box.detail}` : `failed — ${box.detail}`,
                done: true,
                ok: box.connected,
              });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              broadcast({ type: "box_setup", line: `failed — ${detail}`, done: true, ok: false });
            } finally {
              boxUpInFlight = false;
            }
          })();
          return;
        }

        // One real round trip against the endpoint before anything is saved: "invalid
        // api key" from the vendor beats a saved config that fails at the next restart.
        if (route === "POST /api/config/test") {
          if (refused()) return;
          const body = await readJson(req);
          const name = typeof body.provider === "string" ? body.provider.toLowerCase() : "";
          if (!providerNames().includes(name)) {
            send(res, 400, { error: `Unknown provider "${name}".` });
            return;
          }
          try {
            const profile = resolveProvider(name);
            if (typeof body.model === "string" && body.model.trim() !== "") {
              profile.model = body.model.trim();
            }
            if (typeof body.baseUrl === "string" && body.baseUrl.trim() !== "") {
              profile.baseUrl = body.baseUrl.trim();
            }
            const key =
              typeof body.key === "string" && body.key.trim() !== ""
                ? body.key.trim()
                : undefined;
            const result = await testProvider(profile, key);
            send(res, 200, result);
          } catch (error) {
            send(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }

        // Exits with the code the desktop shell treats as "start me again". Under a bare
        // CLI the process simply ends, which the page says out loud before asking.
        if (route === "POST /api/restart") {
          if (refused()) return;
          log("restart requested from the UI");
          send(res, 202, { restarting: true });
          setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
          return;
        }

        if (route === "GET /api/recordings") {
          const client = orchestrator.boxClient();
          if (!client) {
            send(res, 200, { recordings: [] });
            return;
          }
          send(res, 200, await client.listRecordings());
          return;
        }

        if (route === "POST /api/record") {
          if (refused()) return;
          const body = await readJson(req);
          const agentId = String(body.agent ?? "");
          const action = String(body.action ?? "");
          const client = orchestrator.boxClient();

          if (!client) {
            send(res, 503, { error: "The box is not available." });
            return;
          }
          if (!registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }

          // Recorded per desktop, and every agent has its own, so this records exactly
          // the screen the person is looking at.
          const index = registry.displayIndexFor(agentId);
          const name = registry.get(agentId).profile.name;
          try {
            const result =
              action === "start"
                ? await client.startRecording({ display: index, name })
                : await client.stopRecording(index);
            log(
              action === "start"
                ? `recording ${name}'s desktop to ${result.file}`
                : `recording saved: ${result.file} (${result.size_bytes ?? 0} bytes)`
            );
            send(res, 200, result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            send(res, 400, { error: message });
          }
          return;
        }

        if (route === "GET /api/state") {
          // Since local midnight, because "what did today cost" is the question a
          // person glancing at the top bar is asking.
          const midnight = new Date();
          midnight.setHours(0, 0, 0, 0);
          send(res, 200, {
            provider: describeProvider(provider),
            build,
            usageToday: orchestrator.usage.totalsSince(midnight.getTime()),
            // Broken out by person, with a readable name where the id is a principal.
            usageByPrincipal: orchestrator.usage
              .byPrincipalSince(midnight.getTime())
              .map(entry => ({
                principal: entry.principal,
                name: entry.principal === "" ? "unattributed" : principals.resolve(entry.principal).name,
                inputTokens: entry.totals.inputTokens,
                outputTokens: entry.totals.outputTokens,
              })),
            box: { ...box, ok: box.connected },
            allTools: ALL_TOOLS,
            agents: registry.list().map(record => {
              const index = registry.displayIndexFor(record.id);
              return {
                id: record.id,
                name: record.profile.name,
                title: record.profile.title ?? "",
                description: record.profile.description,
                // null means unrestricted — every tool, including ones added later.
                tools: record.profile.tools ?? null,
                ...(record.profile.scopeId !== undefined ? { scopeId: record.profile.scopeId } : {}),
                ...(record.profile.provider !== undefined ? { provider: record.profile.provider } : {}),
                ...(record.profile.model !== undefined ? { model: record.profile.model } : {}),
                // Every agent has its own desktop, so the UI shows whichever one
                // belongs to the agent you are looking at.
                displayIndex: index,
                desktopUrl:
                  `/desktop/${index}/vnc.html?autoconnect=1&resize=scale` +
                  `&path=desktop/${index}/websockify`,
              };
            }),
          });
          return;
        }

        if (route === "GET /api/activity") {
          send(res, 200, activity.list());
          return;
        }

        if (route === "GET /api/transcript") {
          const id = url.searchParams.get("agent") ?? "";
          if (!registry.has(id)) {
            send(res, 404, { error: `No agent ${id}` });
            return;
          }
          // Which thread — the team room by default, or one outside chat.
          const conversation = url.searchParams.get("conversation") ?? MAIN_CONVERSATION;
          // Mapped for reading, not replayed raw: the stored form is written for the
          // model, and the roster is what lets a wake prompt be split back into the
          // messages that caused it.
          const roster = registry.list().map(record => ({
            id: record.id,
            name: record.profile.name,
          }));
          send(res, 200, toDisplayEntries(registry.readTranscript(id, conversation), roster));
          return;
        }

        // Every thread an agent has, so the page can offer a switcher. The team room
        // is always first; the rest are outside chats, newest activity first.
        if (route === "GET /api/conversations") {
          const id = url.searchParams.get("agent") ?? "";
          if (!registry.has(id)) {
            send(res, 404, { error: `No agent ${id}` });
            return;
          }
          const list = registry.listConversations(id).sort((a, b) => {
            if (a.id === MAIN_CONVERSATION) return -1;
            if (b.id === MAIN_CONVERSATION) return 1;
            return String(b.lastAt ?? "").localeCompare(String(a.lastAt ?? ""));
          });
          send(res, 200, { conversations: list });
          return;
        }

        if (route === "POST /api/agents") {
          if (refused()) return;
          const body = await readJson(req);
          const name = String(body.name ?? "").trim();
          if (name === "") {
            send(res, 400, { error: "The agent needs a name." });
            return;
          }
          const tools = readToolList(body.tools);
          if (tools instanceof Error) {
            send(res, 400, { error: tools.message });
            return;
          }
          const created = registry.create({
            name,
            description: String(body.description ?? ""),
            ...(typeof body.title === "string" && body.title.trim() !== ""
              ? { title: body.title.trim() }
              : {}),
            // A full set is stored as no restriction, so a later new tool reaches an
            // agent that was created with "everything" rather than being withheld.
            ...(tools !== undefined && tools !== null && tools.length < ALL_TOOLS.length
              ? { tools }
              : {}),
            // Recorded so "whose agent is this" has an answer. Undefined on a box with no gateway in
            // front, which is the single-user case and stays as it was.
            ...(caller.userId !== undefined ? { ownerUserId: caller.userId } : {}),
            ...(typeof body.scopeId === "string" && body.scopeId !== "" ? { scopeId: body.scopeId } : {}),
            ...(typeof body.provider === "string" && body.provider !== "" ? { provider: body.provider } : {}),
            ...(typeof body.model === "string" && body.model !== "" ? { model: body.model } : {}),
            visibility: body.visibility === "private" ? "private" : "shared",
          });
          log(
            `created agent ${created.profile.name} (${created.id})` +
              (caller.userId === undefined ? "" : ` for ${caller.userId}`)
          );
          send(res, 200, { id: created.id, name: created.profile.name });
          return;
        }

        // Deleting an agent, with the records decision made explicit: archive the
        // directory (transcript, memory, plan — readable, restorable by moving it
        // back) or delete it outright. Refused mid-turn, because tearing the state
        // out from under a running turn manufactures exactly the interrupted-turn
        // recovery case for no reason; and refused for the last agent, because an
        // empty roster is a page with nothing to click.
        if (route === "POST /api/agents/delete") {
          const body = await readJson(req);
          const agentId = String(body.id ?? "");
          if (refused(agentId)) return;
          if (!registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          if (orchestrator.bus.activeAgentIds().includes(agentId)) {
            send(res, 409, {
              error: "This agent is in the middle of a turn. Stop it first, then delete.",
            });
            return;
          }
          if (registry.list().length <= 1) {
            send(res, 400, { error: "This is the last agent; create another before deleting it." });
            return;
          }
          const archive = body.records !== "delete";
          const name = registry.get(agentId).profile.name;
          const result = registry.remove(agentId, { archive });
          log(
            archive
              ? `deleted agent ${name}; records archived to ${result.archivedTo}`
              : `deleted agent ${name} and its records`
          );
          send(res, 200, { deleted: agentId, ...(result.archivedTo ? { archivedTo: result.archivedTo } : {}) });
          return;
        }

        // The human path for editing an agent: persona, role label, name, tool set.
        // Distinct from the model-facing UpdateAgent tool, which cannot touch tools —
        // an agent must not be able to widen anyone's tool set, including its own.
        if (route === "POST /api/agents/update") {
          const body = await readJson(req);
          const agentId = String(body.id ?? "");
          if (refused(agentId)) return;
          if (!registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          const tools = readToolList(body.tools);
          if (tools instanceof Error) {
            send(res, 400, { error: tools.message });
            return;
          }
          const updated = registry.update(agentId, {
            ...(typeof body.name === "string" && body.name.trim() !== ""
              ? { name: body.name.trim() }
              : {}),
            ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(tools !== undefined
              ? { tools: tools === null || tools.length >= ALL_TOOLS.length ? null : tools }
              : {}),
            ...(typeof body.scopeId === "string" ? { scopeId: body.scopeId === "" ? null : body.scopeId } : {}),
            ...(typeof body.provider === "string" ? { provider: body.provider === "" ? null : body.provider } : {}),
            ...(typeof body.model === "string" ? { model: body.model === "" ? null : body.model } : {}),
          });
          log(`updated agent ${updated.profile.name} (${agentId}) from the UI`);
          send(res, 200, { id: agentId, name: updated.profile.name });
          return;
        }

        if (route === "POST /api/prompt") {
          const body = await readJson(req);
          const agentId = String(body.agent ?? "");
          if (refused(agentId)) return;
          const text = String(body.text ?? "").trim();

          if (!registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          if (!text) {
            send(res, 400, { error: "text is required" });
            return;
          }
          // Which thread the page was viewing; defaults to the team room.
          const conversation =
            typeof body.conversation === "string" && body.conversation !== ""
              ? body.conversation
              : MAIN_CONVERSATION;

          // Echo the prompt so every connected page shows it, then answer
          // immediately: the turn's output arrives over the event stream, and a
          // long turn must not hold the HTTP request open.
          // Attributed, so a transcript stops saying "the user" once there is more than one person
          // in a tenant. Carried on the event too, since that is what the feed renders.
          broadcast({
            type: "prompt",
            agentId,
            text,
            conversation,
            ...(caller.userId !== undefined ? { userId: caller.userId } : {}),
          });
          send(res, 202, { accepted: true });

          void orchestrator
            .prompt(agentId, text, caller, { conversation })
            // Teammates woken by this turn are still working; let them finish so
            // their messages and turns show up before the page looks idle.
            .then(() => orchestrator.settle())
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              log(`turn failed: ${message}`);
              broadcast({ type: "error", message });
            });
          return;
        }

        if (route === "GET /api/events") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          res.write(": connected\n\n");
          clients.add(res);

          // Proxies and idle timeouts kill a silent stream; a comment keeps it open
          // without the client having to interpret anything.
          const keepAlive = setInterval(() => {
            try {
              res.write(": ping\n\n");
            } catch {
              clearInterval(keepAlive);
              clients.delete(res);
            }
          }, 20_000);

          req.on("close", () => {
            clearInterval(keepAlive);
            clients.delete(res);
          });
          return;
        }

        send(res, 404, { error: `No route for ${route}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`error on ${route}: ${message}`);
        if (!res.headersSent) send(res, 500, { error: message });
      }
    })();
  });

  /**
   * The WebSocket upgrade that actually carries the screen.
   *
   * Node does not proxy an upgrade for us: the handshake has to be replayed to the
   * upstream verbatim and then the two sockets joined byte-for-byte, because
   * everything after it is framed RFB rather than HTTP.
   */
  server.on("upgrade", (req, clientSocket: Socket, head: Buffer) => {
    const raw = req.url ?? "";
    const [pathname, query] = raw.split("?");
    // The RFB socket carries the screen, so it needs the same check. A browser sends the
    // cookie on an upgrade but cannot set a header, which is why the cookie exists.
    const upgradeDecision = authorize(
      { token, host },
      { authorization: req.headers.authorization, cookie: req.headers.cookie }
    );
    if (!upgradeDecision.allow) {
      clientSocket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }

    // And the role, not only the token: this socket is bidirectional, so authorising it as though
    // it only carried pixels is what let someone who may only watch drive the desktop instead.
    const upstreamPath = desktopUpstreamPath(
      pathname ?? "",
      query ? `?${query}` : "",
      mayDrive(callerOf(req.headers, upgradeDecision.allow))
    );

    if (!upstreamPath) {
      clientSocket.destroy();
      return;
    }

    void openUpgrade(req, clientSocket, head, upstreamPath);
  });

  /** The RFB socket, joined to whichever host port boxd is published on right now. */
  async function openUpgrade(
    req: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
    upstreamPath: string
  ): Promise<void> {
    const origin = await resolveBoxdOrigin();
    if (!origin) {
      clientSocket.destroy();
      return;
    }

    const upstream = netConnect(origin.port, origin.host, () => {
      const headers = Object.entries(req.headers)
        .map(([key, value]) =>
          `${key}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`
        )
        .join("");
      upstream.write(`GET ${upstreamPath} HTTP/1.1\r\n${headers}\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    const drop = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", drop);
    clientSocket.on("error", drop);
  }

  const host = options.host ?? "127.0.0.1";

  // The old justification for having no authentication was that this binds loopback:
  // anything able to reach it can already drive the agents. That stopped being true when
  // the orchestrator moved into the box, where it binds 0.0.0.0 and only Docker's publish
  // address keeps it local. So a non-loopback bind without a configured token gets one
  // generated and announced, rather than being served openly.
  const configured = options.token ?? process.env.AGENTBOX_UI_TOKEN;
  let token = configured;
  if (!token && !isLoopback(host)) {
    token = randomBytes(16).toString("hex");
    log(`bound to ${host} with no token configured; generated one`);
    log(`open: http://${host}:${options.port}/?token=${token}`);
  }
  if (!token) {
    log("no UI token: anything that can reach this port can drive the agents");
  }
  // Derived, so rotating the token ends every web session with it — and so there is no
  // second secret to store. Assigned before anything can serve a request.
  sessionSecret = sessionKey(token);
  await new Promise<void>(resolve => server.listen(options.port, host, resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  // Scheduled skills start firing only once something is serving. A CLI invocation that asks one
  // question should not begin running someone's automations as a side effect, so this lives here
  // rather than in the orchestrator's constructor.
  if (process.env.AGENTBOX_SCHEDULER !== "0") {
    orchestrator.scheduler.start();
    log("scheduled skills are armed; set AGENTBOX_SCHEDULER=0 to leave them idle");
  }

  options.onReady?.(`http://${host}:${port}`);

  return () => {
    for (const client of clients) client.end();
    // The backup timer, or an embedding that restarts the server in one process leaves the old one
    // firing alongside the new — two backups a tick, sharing a timestamp and a partial directory.
    backups?.stop();
    clearInterval(boxWatch);
    channels.stop();
    orchestrator.scheduler.stop();
    server.close();
  };
}

/**
 * Where in the box a desktop request goes — and, for someone who may only watch, the view-only
 * copy of the same desktop.
 *
 * The browser's URL is identical either way, so nothing about the page depends on the role and a
 * viewer cannot reach the driving stream by editing an address: the choice is made here, from the
 * identity the gateway asserted, and boxd itself does not authenticate this path.
 *
 * Read-only used to mean only that the HTTP routes refused to mutate. The screen was proxied to
 * anyone with a session, and x11vnc was not started view-only, so a viewer could type into the
 * desktop over RFB — every mutation check passed while the person did whatever they liked.
 */
export function desktopUpstreamPath(
  pathname: string,
  search: string,
  canDrive: boolean
): string | undefined {
  const match = /^\/desktop\/(\d+)(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  const rest = match[2] ?? "/";
  return `/${canDrive ? "vnc" : "vnc-ro"}/${match[1]}${rest}${search}`;
}

