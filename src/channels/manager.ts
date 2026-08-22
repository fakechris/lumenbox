/**
 * Chat channels: the agents, reachable from a phone.
 *
 * The web UI answers "what are they doing"; a channel answers "make them do something,
 * from wherever I am". One message in, the addressed agent runs a full turn, and what
 * it said comes back as the reply — the same transcript, the same policy gate, the
 * same budget as every other way in. A channel is a front door, not a second product.
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
  /** For a person reading the activity feed: a name, not an id, where the wire has one. */
  senderLabel: string;
  text: string;
}

export interface ChannelAdapter {
  readonly name: string;
  /** Resolves once the wire is up; rejects when it cannot come up. */
  start(onMessage: (message: InboundMessage) => Promise<string | undefined>): Promise<void>;
  stop(): void;
  /** Pushes a line to where this identity's messages come from, if the wire allows it. */
  send(identity: string, text: string): Promise<void>;
}

export interface ChannelStatus {
  name: string;
  configured: boolean;
  running: boolean;
  detail: string;
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
   * Runs one turn and returns what the agent said. `agentName` is undefined for the
   * default agent; unknown names should throw with a message worth relaying.
   * `chatKey` names the chat, for the conversation thread the turn runs in.
   */
  ask: (
    agentName: string | undefined,
    text: string,
    identity: string,
    chatKey: string
  ) => Promise<string>;
  log: (line: string) => void;
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

export class ChannelManager {
  private readonly adapters: ChannelAdapter[] = [];
  private readonly statuses = new Map<string, ChannelStatus>();
  /** Where each agent's last channel instruction came from, for routing notices back. */
  private readonly lastAsker = new Map<string, { adapter: ChannelAdapter; identity: string }>();

  constructor(private readonly deps: ChannelManagerDeps) {}

  register(adapter: ChannelAdapter, configured: boolean, detail: string): void {
    this.statuses.set(adapter.name, { name: adapter.name, configured, running: false, detail });
    if (configured) this.adapters.push(adapter);
  }

  start(): void {
    for (const adapter of this.adapters) {
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

  list(): ChannelStatus[] {
    return [...this.statuses.values()];
  }

  /**
   * A notice for whoever last drove this agent from a channel — an approval waiting,
   * mostly. Quietly nothing when the agent was never driven from a channel: the web
   * page covers that case already.
   */
  notifyAsker(agentId: string, text: string): void {
    const asker = this.lastAsker.get(agentId);
    if (asker === undefined) return;
    void asker.adapter.send(asker.identity, text).catch(() => {
      // The notice is best-effort; the approval itself still shows in the UI.
    });
  }

  /** Remembers who to notify for an agent. Called by `ask` wiring with the agent id. */
  remember(agentId: string, adapterName: string, identity: string): void {
    const adapter = this.adapters.find(a => a.name === adapterName);
    if (adapter !== undefined) this.lastAsker.set(agentId, { adapter, identity });
  }

  private setStatus(name: string, patch: Partial<ChannelStatus>): void {
    const current = this.statuses.get(name);
    if (current !== undefined) this.statuses.set(name, { ...current, ...patch });
  }

  private async handle(
    adapter: ChannelAdapter,
    message: InboundMessage
  ): Promise<string | undefined> {
    if (!this.deps.mayDrive(message.identity)) {
      this.deps.log(
        `channel ${adapter.name}: refused ${message.identity} (${message.senderLabel})`
      );
      return refusal(message.identity);
    }

    const { agentName, text } = parseAddress(message.text);
    if (text === "") return "Say what you need done; @AgentName first to pick who does it.";
    try {
      const reply = await this.deps.ask(
        agentName,
        text,
        message.identity,
        message.chatKey ?? message.identity
      );
      return reply.trim() === "" ? "Done. (The agent finished without saying anything.)" : reply;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
