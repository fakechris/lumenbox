/**
 * Chat channels: the agents, reachable from a phone.
 *
 * The web UI answers "what are they doing"; a channel answers "make them do something,
 * from wherever I am". One message in, the addressed agent runs a full turn, and what
 * it said comes back as the reply — the same transcript, the same policy gate, the
 * same budget as every other way in. A channel is a front door, not a second product.
 *
 * **Accepted is not answered.** A turn runs for minutes; a chat platform's event
 * handler must return in seconds or the platform redelivers the event, and a
 * redelivered event is a duplicate turn. So `handle` acknowledges on the wire
 * immediately and the work runs behind it: a quick turn just posts its answer, a slow
 * one first says it is under way (a card where the adapter can, a line where it
 * cannot), and the result is pushed to the chat when it lands.
 *
 * **Closed by default.** A bot handle is discoverable, and "anyone who finds it can
 * drive a machine with a shell" is not a default anyone chose. The allow list lives in
 * the config file; an unauthorised sender is told their own `channel:id`, which is
 * exactly the string the owner needs to add. An empty list means nobody.
 *
 * Each adapter owns its own wire (long polling, a websocket) and reports its state
 * here; a channel that cannot connect says so in the settings dialog rather than
 * failing silently. Secrets arrive as environment variables — including via the
 * config file's env map — never as constructor literals.
 */

export interface InboundMessage {
  /** `telegram:123` — stable, and what the allow list matches. Who is *speaking*. */
  identity: string;
  /**
   * Which chat the message came from, when that is not the same thing as who sent
   * it — a Feishu group's id, a DingTalk conversation. This is what the agent's
   * conversation thread is keyed on: context belongs to the room it happened in,
   * while permission belongs to the person. Absent means the identity is the chat
   * (a Telegram chat id already is one).
   */
  chatKey?: string;
  /**
   * The wire's own id for this message, when it has one. It is what a reply anchors
   * to and what a status reaction attaches to. One rule downstream: everything a task
   * says is anchored to the message that asked for it — in a main chat that opens a
   * topic, inside a topic it stays there. The *conversation* stays keyed on the chat
   * either way: context belongs to the room, and a reply inside a task's topic must
   * reach the turn that is running, not open a parallel one.
   */
  messageId?: string;
  /** For a person reading the activity feed: a name, not an id, where the wire has one. */
  senderLabel: string;
  text: string;
}

/** Where a push should sit: anchored under a message, or loose in the chat. */
export interface PushOptions {
  replyTo?: string;
}

/**
 * A task as a chat renders it: one card per request, updated in place.
 *
 * The states are the ones a person in a group actually distinguishes — waiting,
 * happening, finished, broken — not the turn engine's internals. `action` is the
 * latest one-line answer to "what is it doing right now", which is the whole reason
 * to look at the card while it runs.
 */
export interface TaskCardState {
  /** The instruction, first line, for the card header. */
  title: string;
  /** Who is doing it — the addressed agent, or empty for the default. */
  agentName: string;
  /** Who asked, as the wire names them. */
  requesterLabel: string;
  status: "queued" | "working" | "done" | "failed";
  /** The latest one-line action, e.g. `bash: npm test`. Absent when not started or finished. */
  action?: string;
  /** How many requests are ahead of this one, when queued. */
  ahead?: number;
}

export interface ChannelAdapter {
  readonly name: string;
  /** Resolves once the wire is up; rejects when it cannot come up. */
  start(onMessage: (message: InboundMessage) => Promise<string | undefined>): Promise<void>;
  stop(): void;
  /** Pushes a line to where this identity's messages come from, if the wire allows it. */
  send(identity: string, text: string): Promise<void>;
  /**
   * Pushes a line to a chat by its chatKey. Preferred over `send` for task results:
   * `send` routes to wherever the identity last spoke, which may have moved to another
   * chat while a long task ran. Absent means the identity is the chat and `send` is right.
   */
  sendToChat?(chatKey: string, text: string, options?: PushOptions): Promise<void>;
  /**
   * Posts a task card to a chat and returns the handle `updateTaskCard` accepts, or
   * undefined when the card could not be posted. Adapters without cards leave both
   * absent and get plain acknowledgement lines instead.
   */
  postTaskCard?(
    chatKey: string,
    card: TaskCardState,
    options?: PushOptions
  ): Promise<string | undefined>;
  /** Rewrites a posted card in place. Updates are quiet; a chat is not notified for one. */
  updateTaskCard?(handle: string, card: TaskCardState): Promise<void>;
  /** Posts an image (base64 WebP) to a chat. Absent means the wire cannot show one. */
  sendImage?(chatKey: string, base64: string, options?: PushOptions): Promise<void>;
  /**
   * Marks the message that started a task with its state — working, done, failed —
   * however the wire can say that (Feishu: an emoji reaction). Cheap presence for
   * the quick tasks that never earn a card, and a loud mark when something broke.
   */
  noteStatus?(messageId: string, status: "working" | "done" | "failed"): Promise<void>;
  /**
   * Posts a consent request with buttons to wherever this identity's messages come
   * from. Absent means the wire has no buttons and the text-verb path is used.
   */
  postApprovalCard?(identity: string, card: ApprovalCardState): Promise<void>;
  /**
   * Registers the handler for a pressed approval button. The handler returns the
   * line to show in the chat, or undefined when the press was refused or stale.
   */
  onApprovalAction?(
    handler: (press: {
      approvalId: string;
      reply: ApprovalReply;
      identity: string;
    }) => Promise<string | undefined>
  ): void;
}

/** A pending consent, as a card with buttons renders it. */
export interface ApprovalCardState {
  approvalId: string;
  agentName: string;
  /** The original action, verbatim — an approval that paraphrases is an injection surface. */
  description: string;
}

export interface ChannelStatus {
  name: string;
  configured: boolean;
  running: boolean;
  detail: string;
}

/** How a one-word reply on a chat answers a pending approval. */
export type ApprovalReply = "once" | "always" | "session" | "deny";

/**
 * Reads a whole message as an approval answer, or nothing.
 *
 * The message must be *only* the verb — "allow" answers, "allow the download" does not,
 * because the second is a person talking about the request, not deciding it, and a
 * loose match would approve a dangerous action from an offhand sentence.
 */
export function parseApprovalReply(text: string): ApprovalReply | undefined {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (["allow", "approve", "yes", "ok", "y", "允许", "同意", "批准", "好"].includes(t)) return "once";
  if (["allow always", "always", "一直允许", "总是允许"].includes(t)) return "always";
  if (["allow session", "session", "本次会话"].includes(t)) return "session";
  if (["deny", "refuse", "reject", "no", "n", "拒绝", "不"].includes(t)) return "deny";
  return undefined;
}

export interface ChannelManagerDeps {
  /**
   * Whether this identity may command the agents from a channel, read fresh each
   * message so a role change needs no restart. A viewer (or an unknown sender) is
   * refused and told their id; a driver or admin is let through. Permission is a
   * property of the person, which is why this takes an identity and not a chat.
   */
  mayDrive: (identity: string) => boolean;
  /**
   * Answers a pending approval by id, at a scope. Returns a line to send back, or
   * undefined when the approval is no longer waiting (answered from the web meanwhile,
   * or the turn moved on). The manager only calls this for an approval it pushed to
   * this identity, so authorization is already the mayDrive check that let the pushed
   * turn run.
   */
  answerApproval?: (approvalId: string, reply: ApprovalReply) => string | undefined;
  /**
   * Runs one turn and returns what the agent said. `agentName` is undefined for the
   * default agent; unknown names should throw with a message worth relaying.
   * `chatKey` names the chat, for the conversation thread the turn runs in.
   * `onProgress`, when given, receives a one-line description of each action the turn
   * takes, for the task card — coarse by design, a card is not a transcript.
   */
  ask: (
    agentName: string | undefined,
    text: string,
    identity: string,
    chatKey: string,
    onProgress?: (action: string) => void
  ) => Promise<string>;
  /**
   * How many requests are ahead of a new one for this agent and chat. Zero means it
   * starts now. Absent means unknown, which is treated as zero — the acknowledgement
   * then says less rather than guessing.
   */
  ahead?: (agentName: string | undefined, chatKey: string) => number;
  /**
   * How long a turn may run before the chat is told it is under way. A quick answer
   * should arrive as itself, not behind a "working on it" — the threshold is what
   * separates the two. Queued work skips the wait: queued is known-slow.
   */
  ackAfterMs?: number;
  /**
   * The agent's desktop right now, as base64 WebP, or undefined when there is no
   * desktop to show. What "屏幕" asks for, and what a finished task attaches — the
   * one thing no other chat product can put in a group.
   */
  screenshot?: (agentName: string | undefined) => Promise<string | undefined>;
  /**
   * Redeems an invite code for this identity and returns the line to send back —
   * "you're in as driver", or why not. Reached *before* the allow check, because the
   * whole point of a code is that the sender is not authorised yet.
   */
  bind?: (code: string, identity: string, senderLabel: string) => string;
  /**
   * Records that somebody unknown knocked, for one-click approval in the app. The
   * refusal then says the owner was told, instead of handing the person an id to
   * copy around — the refusal is the registration page.
   */
  knock?: (request: { identity: string; senderLabel: string; channel: string }) => void;
  log: (line: string) => void;
}

/** After this long, a running task without a card says it is under way. */
const ACK_AFTER_MS = 8_000;

/** Card rewrites are rate-limited to this; the final state is always written. */
const CARD_UPDATE_MS = 3_000;

/**
 * Whether a whole message is a request to see the desktop.
 *
 * Whole-message like the approval verbs, and for the same reason: "看看屏幕上的报错"
 * is a person talking about the screen, not asking for a picture of it.
 */
export function parseScreenRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?]+$/, "");
  return ["screen", "screenshot", "屏幕", "看屏幕", "看看屏幕", "截图"].includes(t);
}

/** `@Name rest of the message` addresses a specific agent; anything else is the default. */
export function parseAddress(text: string): { agentName?: string; text: string } {
  const match = /^@([\p{L}\p{N}_-]+)\s+([\s\S]+)$/u.exec(text.trim());
  if (match === null) return { text: text.trim() };
  return { agentName: match[1], text: match[2]!.trim() };
}

export function refusal(identity: string): string {
  return (
    `Not authorised. This LumenBox only answers people on its allow list.\n` +
    `Your id is: ${identity}\n` +
    `The owner can add it under Settings → Channels, or to channelAllow in ` +
    `~/.agentbox/config.json, and this message is the whole reason the id is shown.`
  );
}

/**
 * The refusal when the owner was just told about the knock: an invitation to wait,
 * not an id to copy around. The id still appears, last, for the manual path.
 */
export function knockRefusal(identity: string): string {
  return (
    `You're not on this LumenBox's list yet. The owner has been notified and can let ` +
    `you in with one click — you'll hear back here once they do. If they gave you an ` +
    `invite code, send it as: bind <code>\n` +
    `(Your id, for the manual path: ${identity})`
  );
}

/** A whole message of the shape `bind <code>` / `绑定 <码>`, or nothing. */
export function parseBind(text: string): string | undefined {
  const match = /^(?:bind|绑定)[\s::]+([a-z0-9-]{4,12})$/i.exec(text.trim());
  return match === null ? undefined : match[1]!.toUpperCase();
}

export class ChannelManager {
  private readonly adapters: ChannelAdapter[] = [];
  private readonly statuses = new Map<string, ChannelStatus>();
  /** Where each agent's last channel instruction came from, for routing notices back. */
  private readonly lastAsker = new Map<string, { adapter: ChannelAdapter; identity: string }>();
  /**
   * The approval each channel person can answer right now, keyed by their identity.
   *
   * Set when an approval for a turn they drove is pushed to their chat; a one-word
   * reply from that identity answers it. Cleared once answered, so a stray "ok" later
   * does not approve something new.
   */
  private readonly awaitingApproval = new Map<string, { approvalId: string; description: string }>();
  /**
   * Tasks still running behind an already-acknowledged wire. Held so `idle` can wait
   * for them — a shutdown that drops a task mid-push loses a result somebody was told
   * would arrive — and so a test can await the work `handle` deliberately does not.
   */
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: ChannelManagerDeps) {}

  register(adapter: ChannelAdapter, configured: boolean, detail: string): void {
    this.statuses.set(adapter.name, { name: adapter.name, configured, running: false, detail });
    if (configured) this.adapters.push(adapter);
  }

  start(): void {
    for (const adapter of this.adapters) {
      // A button in a room is pressable by whoever the room trusts to drive — the
      // same set the text verbs trust — checked at press time, not at render time,
      // because a card outlives the moment it was posted.
      adapter.onApprovalAction?.(async press => {
        if (!this.deps.mayDrive(press.identity)) return undefined;
        const result = this.deps.answerApproval?.(press.approvalId, press.reply);
        // However it was answered, nobody's one-word reply should now hit something else.
        for (const [identity, waiting] of this.awaitingApproval) {
          if (waiting.approvalId === press.approvalId) this.awaitingApproval.delete(identity);
        }
        return (
          result ??
          "That consent is no longer waiting — it may have been answered from the app, " +
            "or the turn moved on."
        );
      });
      adapter
        .start(message => this.handle(adapter, message))
        .then(() => {
          this.setStatus(adapter.name, { running: true, detail: "connected" });
          this.deps.log(`channel ${adapter.name}: connected`);
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          this.setStatus(adapter.name, { running: false, detail });
          this.deps.log(`channel ${adapter.name}: ${detail}`);
        });
    }
  }

  stop(): void {
    for (const adapter of this.adapters) adapter.stop();
  }

  /** Resolves when every accepted task has pushed its result (or its failure). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  list(): ChannelStatus[] {
    return [...this.statuses.values()];
  }

  /** Remembers who to notify for an agent. Called by `ask` wiring with the agent id. */
  remember(agentId: string, adapterName: string, identity: string): void {
    const adapter = this.adapters.find(a => a.name === adapterName);
    if (adapter !== undefined) this.lastAsker.set(agentId, { adapter, identity });
  }

  /**
   * Pushes a pending approval to whoever last drove this agent from a chat, and
   * remembers it so a one-word reply from them answers it. Nothing when the agent was
   * not driven from a channel — the web page covers that.
   */
  notifyApproval(agentId: string, approvalId: string, agentName: string, description: string): void {
    const asker = this.lastAsker.get(agentId);
    if (asker === undefined) return;
    this.awaitingApproval.set(asker.identity, { approvalId, description });
    // Buttons where the wire has them; the word path stays open either way, because a
    // person answering "允许" at a card is right, not wrong.
    if (asker.adapter.postApprovalCard !== undefined) {
      void asker.adapter
        .postApprovalCard(asker.identity, { approvalId, agentName, description })
        .catch(() => {
          // The web UI still shows it; a failed push is not a lost approval.
        });
      return;
    }
    const message =
      `${agentName || "An agent"} needs your consent:\n${description}\n\n` +
      `Reply "allow" for once, "always" to stop asking for this, or "deny". ` +
      `The turn is paused until you answer.`;
    void asker.adapter.send(asker.identity, message).catch(() => {
      // The web UI still shows it; a failed push is not a lost approval.
    });
  }

  private setStatus(name: string, patch: Partial<ChannelStatus>): void {
    const current = this.statuses.get(name);
    if (current !== undefined) this.statuses.set(name, { ...current, ...patch });
  }

  /** Pushes a line to an identity through a named adapter. The approve-notification path. */
  push(adapterName: string, identity: string, text: string): Promise<void> {
    const adapter = this.adapters.find(a => a.name === adapterName);
    if (adapter === undefined) return Promise.resolve();
    return adapter.send(identity, text).catch(() => {});
  }

  private async handle(
    adapter: ChannelAdapter,
    message: InboundMessage
  ): Promise<string | undefined> {
    // An invite code is checked before the allow list: the sender not being on it yet
    // is the whole reason codes exist. A non-code message from a stranger still knocks.
    const code = parseBind(message.text);
    if (code !== undefined && this.deps.bind !== undefined) {
      return this.deps.bind(code, message.identity, message.senderLabel);
    }

    if (!this.deps.mayDrive(message.identity)) {
      this.deps.log(
        `channel ${adapter.name}: refused ${message.identity} (${message.senderLabel})`
      );
      if (this.deps.knock !== undefined) {
        this.deps.knock({
          identity: message.identity,
          senderLabel: message.senderLabel,
          channel: adapter.name,
        });
        return knockRefusal(message.identity);
      }
      return refusal(message.identity);
    }

    // A one-word answer to a consent this person was asked for is a decision, not a
    // new instruction: answer the approval and do not start a turn. Checked before
    // address parsing, so "allow" is never read as a message to an agent named allow.
    const pending = this.awaitingApproval.get(message.identity);
    if (pending !== undefined) {
      const reply = parseApprovalReply(message.text);
      if (reply !== undefined) {
        this.awaitingApproval.delete(message.identity);
        const result = this.deps.answerApproval?.(pending.approvalId, reply);
        return (
          result ??
          "That consent is no longer waiting — it may have been answered from the app, " +
            "or the turn moved on. Send the request again if it still needs doing."
        );
      }
    }

    const { agentName, text } = parseAddress(message.text);
    if (text === "") return "Say what you need done; @AgentName first to pick who does it.";

    // "屏幕" is a look, not a task: no turn runs, the desktop is captured as it is.
    const work =
      parseScreenRequest(text) && this.deps.screenshot !== undefined
        ? this.runScreenshot(adapter, message, agentName)
        : this.runTask(adapter, message, agentName, text);

    // The work runs behind this return; the decisions above stay synchronous because
    // a refusal or an approval answer *is* the whole response.
    const task = work.finally(() => {
      this.inflight.delete(task);
    });
    this.inflight.add(task);
    return undefined;
  }

  /** A line to the room that asked, or to the sender where the wire has no rooms. */
  private async deliver(
    adapter: ChannelAdapter,
    chatKey: string,
    identity: string,
    line: string,
    options?: PushOptions
  ): Promise<void> {
    try {
      if (adapter.sendToChat !== undefined) await adapter.sendToChat(chatKey, line, options);
      else await adapter.send(identity, line);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.log(`channel ${adapter.name}: push failed (${detail})`);
    }
  }

  /** The desktop, now, into the chat — or the honest reason there is no picture. */
  private async runScreenshot(
    adapter: ChannelAdapter,
    message: InboundMessage,
    agentName: string | undefined
  ): Promise<void> {
    const chatKey = message.chatKey ?? message.identity;
    const anchor: PushOptions | undefined =
      message.messageId !== undefined ? { replyTo: message.messageId } : undefined;
    try {
      const image = await this.deps.screenshot!(agentName);
      if (image === undefined) {
        await this.deliver(
          adapter,
          chatKey,
          message.identity,
          "No desktop to show — the box may be off, or this agent has not started one.",
          anchor
        );
        return;
      }
      if (adapter.sendImage === undefined) {
        await this.deliver(
          adapter,
          chatKey,
          message.identity,
          "This channel cannot show images; open the app to watch the desktop.",
          anchor
        );
        return;
      }
      await adapter.sendImage(chatKey, image, anchor);
    } catch (error) {
      await this.deliver(
        adapter,
        chatKey,
        message.identity,
        error instanceof Error ? error.message : String(error),
        anchor
      );
    }
  }

  /**
   * One accepted request, from acknowledgement to pushed result.
   *
   * Everything here degrades by capability: a card where the adapter has one, a line
   * where it does not; a chat-addressed push where the wire distinguishes chats from
   * senders, an identity-addressed one where it does not. Failures to *deliver* are
   * logged and swallowed — the turn itself already ran, and its record is the
   * transcript, not the chat.
   */
  private async runTask(
    adapter: ChannelAdapter,
    message: InboundMessage,
    agentName: string | undefined,
    text: string
  ): Promise<void> {
    const chatKey = message.chatKey ?? message.identity;
    // Everything this task says sits under the message that asked for it.
    const anchor: PushOptions | undefined =
      message.messageId !== undefined ? { replyTo: message.messageId } : undefined;
    const deliver = (line: string) =>
      this.deliver(adapter, chatKey, message.identity, line, anchor);
    const mark = (status: "working" | "done" | "failed") => {
      if (message.messageId === undefined) return;
      void adapter.noteStatus?.(message.messageId, status).catch(() => {});
    };
    mark("working");

    const ahead = this.deps.ahead?.(agentName, chatKey) ?? 0;
    const card: TaskCardState = {
      title: firstLine(text),
      agentName: agentName ?? "",
      requesterLabel: message.senderLabel,
      status: ahead > 0 ? "queued" : "working",
      ...(ahead > 0 ? { ahead } : {}),
    };

    // The acknowledgement, when one is owed: a card if the adapter can, a line if not.
    // Queued work is acknowledged immediately — queued is known-slow — while work that
    // starts now gets the threshold, so a quick answer arrives as itself.
    let cardHandle: string | undefined;
    let acknowledged = false;
    let lastCardWrite = 0;
    const acknowledge = async () => {
      if (acknowledged) return;
      acknowledged = true;
      if (adapter.postTaskCard !== undefined) {
        try {
          cardHandle = await adapter.postTaskCard(chatKey, { ...card }, anchor);
          lastCardWrite = Date.now();
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.deps.log(`channel ${adapter.name}: card failed (${detail})`);
        }
        return;
      }
      await deliver(ackLine(card));
    };

    const ackTimer = setTimeout(() => {
      void acknowledge();
    }, this.deps.ackAfterMs ?? ACK_AFTER_MS);
    if (ahead > 0) void acknowledge();

    // Progress rewrites the card, rate-limited; without a card it goes nowhere, on
    // purpose — a plain chat told "tool call #14" fourteen times is spam, not progress.
    const onProgress = (action: string) => {
      card.status = "working";
      delete card.ahead;
      card.action = action;
      if (cardHandle === undefined || adapter.updateTaskCard === undefined) return;
      const now = Date.now();
      if (now - lastCardWrite < CARD_UPDATE_MS) return;
      lastCardWrite = now;
      void adapter.updateTaskCard(cardHandle, { ...card }).catch(() => {});
    };

    const finishCard = (status: "done" | "failed") => {
      if (cardHandle === undefined || adapter.updateTaskCard === undefined) return;
      card.status = status;
      delete card.action;
      delete card.ahead;
      void adapter.updateTaskCard(cardHandle, { ...card }).catch(() => {});
    };

    try {
      const reply = await this.deps.ask(agentName, text, message.identity, chatKey, onProgress);
      clearTimeout(ackTimer);
      finishCard("done");
      mark("done");
      await deliver(
        reply.trim() === "" ? "Done. (The agent finished without saying anything.)" : reply
      );
      // The desk as the task left it: evidence at a glance. Only for work long enough
      // to have been acknowledged — a quick answer does not need a poster — and never
      // a failure: the reply already landed, and its record is the transcript.
      if (acknowledged && adapter.sendImage !== undefined && this.deps.screenshot !== undefined) {
        try {
          const image = await this.deps.screenshot(agentName);
          if (image !== undefined) await adapter.sendImage(chatKey, image, anchor);
        } catch {
          // Nothing: the missing poster is not worth a line in the chat.
        }
      }
    } catch (error) {
      clearTimeout(ackTimer);
      finishCard("failed");
      mark("failed");
      await deliver(error instanceof Error ? error.message : String(error));
    }
  }
}

/** The instruction as a card header: its first line, clamped. */
function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** The plain-text acknowledgement, for adapters without cards. */
function ackLine(card: TaskCardState): string {
  const who = card.agentName === "" ? "The team" : card.agentName;
  if (card.status === "queued" && card.ahead !== undefined) {
    const others = card.ahead === 1 ? "1 request" : `${card.ahead} requests`;
    return `Got it — ${who} has ${others} ahead of this one. The result will be posted here.`;
  }
  return `${who} is on it. This may take a while; the result will be posted here.`;
}
