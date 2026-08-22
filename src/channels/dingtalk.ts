/**
 * DingTalk, over Stream Mode.
 *
 * Stream Mode is DingTalk's documented no-public-URL path: open a gateway
 * connection with the app credentials, get a websocket endpoint and ticket, and
 * bot messages arrive as JSON frames. Hand-rolled rather than through the vendor
 * SDK because the protocol is small, documented JSON — a subscription frame, a
 * ping to answer, an ack per message — and Node's built-in WebSocket covers it.
 *
 * Replies go to the `sessionWebhook` each message carries: scoped to that
 * conversation, expiring, and needing no extra token — which is exactly the shape
 * a reply should have.
 */

import type { ChannelAdapter, InboundMessage } from "./manager.ts";

const GATEWAY = "https://api.dingtalk.com/v1.0/gateway/connections/open";
const TOPIC = "/v1.0/im/bot/messages/get";

interface StreamFrame {
  specVersion?: string;
  type?: string;
  headers?: { topic?: string; messageId?: string };
  data?: string;
}

interface BotMessage {
  text?: { content?: string };
  senderStaffId?: string;
  senderNick?: string;
  conversationId?: string;
  sessionWebhook?: string;
}

export class DingTalkChannel implements ChannelAdapter {
  readonly name = "dingtalk";
  private stopped = false;
  private socket: WebSocket | undefined;
  /** Reply webhooks by identity, so a later notice can reach the same conversation. */
  private readonly webhooks = new Map<string, string>();

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly log: (line: string) => void
  ) {}

  async start(
    onMessage: (message: InboundMessage) => Promise<string | undefined>
  ): Promise<void> {
    await this.connect(onMessage);
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  async send(identity: string, text: string): Promise<void> {
    const webhook = this.webhooks.get(identity);
    if (webhook === undefined) return;
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    });
  }

  private async connect(
    onMessage: (message: InboundMessage) => Promise<string | undefined>
  ): Promise<void> {
    const opened = await fetch(GATEWAY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        subscriptions: [{ type: "CALLBACK", topic: TOPIC }],
        ua: "lumenbox",
      }),
    });
    if (!opened.ok) {
      throw new Error(`dingtalk gateway: ${opened.status} ${(await opened.text()).slice(0, 300)}`);
    }
    const { endpoint, ticket } = (await opened.json()) as { endpoint?: string; ticket?: string };
    if (!endpoint || !ticket) throw new Error("dingtalk gateway: no endpoint in response");

    const socket = new WebSocket(`${endpoint}?ticket=${ticket}`);
    this.socket = socket;

    socket.addEventListener("message", event => {
      let frame: StreamFrame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const messageId = frame.headers?.messageId ?? "";
      // Every frame is acked, ping and message alike: an unacked message is redelivered,
      // and a redelivered instruction is a turn run twice.
      const ack = (data: string) =>
        socket.send(
          JSON.stringify({
            code: 200,
            headers: { messageId, contentType: "application/json" },
            message: "OK",
            data,
          })
        );

      if (frame.type === "SYSTEM") {
        ack(frame.data ?? "{}");
        return;
      }
      if (frame.headers?.topic !== TOPIC) {
        ack("{}");
        return;
      }
      ack(JSON.stringify({ response: {} }));

      let payload: BotMessage;
      try {
        payload = JSON.parse(frame.data ?? "{}");
      } catch {
        return;
      }
      const text = payload.text?.content?.trim() ?? "";
      const sender = payload.senderStaffId ?? payload.conversationId ?? "unknown";
      const identity = `dingtalk:${sender}`;
      if (payload.sessionWebhook) this.webhooks.set(identity, payload.sessionWebhook);
      if (text === "") return;
      void onMessage({
        identity,
        senderLabel: payload.senderNick ?? sender,
        text,
      })
        .then(reply => (reply ? this.send(identity, reply) : undefined))
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          this.log(`channel dingtalk: reply failed (${detail})`);
        });
    });

    socket.addEventListener("close", () => {
      if (this.stopped) return;
      this.log("channel dingtalk: connection closed; reconnecting in 5s");
      setTimeout(() => {
        void this.connect(onMessage).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          this.log(`channel dingtalk: reconnect failed (${detail})`);
        });
      }, 5000);
    });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("dingtalk: websocket error")), {
        once: true,
      });
    });
  }
}
