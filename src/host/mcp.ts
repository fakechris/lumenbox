/**
 * MCP clients: the tools other people wrote.
 *
 * The agents here have a dozen hand-built tools, and the ecosystem has thousands —
 * search, ticket systems, databases, the vendor SDK somebody published last week.
 * Writing each of those is a tax nobody should pay twice, so this speaks the protocol
 * they already publish instead.
 *
 * **Hand-rolled, over stdio, on purpose.** The wire is JSON-RPC 2.0 in newline-delimited
 * JSON over a child process's stdin and stdout: `initialize`, `tools/list`, `tools/call`.
 * That is small enough to own outright, and owning it keeps the two-dependency rule that
 * every other integration here has kept. The SDK and the HTTP transports become worth
 * their weight when a server we actually want speaks only those; the seam for that is
 * this file's public surface, which names servers and tools and never mentions a pipe.
 *
 * **The tools an MCP server offers are ordinary tools once they arrive.** They are
 * offered through the same allowlist an agent's profile and its scope already narrow,
 * they pass the same policy gate, and their calls and results land in the same
 * transcript as everything else — so an external tool cannot become a hole in either
 * the authorization story or the evidence one.
 *
 * A server that will not start, or dies, is reported and skipped. An installation whose
 * ticket system is down should lose that tool, not every turn.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** A description's first sentence, clamped — enough to choose by, not to call by. */
function firstSentence(text: string): string {
  const line = text.split(/(?<=[.!?])\s|\n/, 1)[0] ?? text;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** Tool names carry their server, so two servers may both offer `search`. */
export const MCP_SEPARATOR = "__";

export interface McpServerConfig {
  /** How this server is named in tool names and in the settings dialog. */
  name: string;
  command: string;
  args?: string[];
  /** Extra environment for the child. Inherits the orchestrator's, minus nothing. */
  env?: Record<string, string>;
}

export interface McpTool {
  /** `server__tool`, which is what the model sees and what an allowlist matches. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerStatus {
  name: string;
  running: boolean;
  toolCount: number;
  detail: string;
}

/**
 * Above this many external tools in total, they stop being offered one by one.
 *
 * Every tool's name, description and schema is in every agent's prompt on every turn,
 * so a generous server or three is a permanent tax on every conversation the
 * installation ever has — the roster problem, arriving through a different door. Past
 * this line the whole set is replaced by two tools that look it up on demand, which
 * costs one extra round trip when an external tool is actually wanted and nothing at
 * all when it is not.
 *
 * Thirty because that is roughly where the tool block stops being a list and starts
 * being a document.
 */
export const TOOL_BUDGET_WARNING = 30;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const CALL_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 30_000;

/**
 * One server, its process, and the requests in flight against it.
 *
 * Deliberately not a general JSON-RPC client: it answers requests it sent, ignores
 * everything else (a server's notifications are not part of the tool story yet), and
 * has one job per method.
 */
class McpServer {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private tools: McpTool[] = [];
  private detail = "not started";
  private startPromise: Promise<void> | undefined;

  constructor(
    readonly config: McpServerConfig,
    private readonly log: (line: string) => void
  ) {}

  status(): McpServerStatus {
    return {
      name: this.config.name,
      running: this.child !== undefined && this.child.exitCode === null,
      toolCount: this.tools.length,
      detail: this.detail,
    };
  }

  listTools(): McpTool[] {
    return this.tools;
  }

  /** Starts if needed, and resolves once the tool list is known. Never throws to callers. */
  ensureStarted(): Promise<void> {
    if (this.startPromise !== undefined) return this.startPromise;
    this.startPromise = this.start().catch(error => {
      this.detail = error instanceof Error ? error.message : String(error);
      this.log(`mcp ${this.config.name}: ${this.detail}`);
      // Cleared so a later turn retries: a server that was down when the box booted
      // should not be dead for the life of the process.
      this.startPromise = undefined;
      this.stop();
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => this.onData(chunk as string));
    child.stderr.setEncoding("utf8");
    // A server's stderr is its diagnostics, not our failure: logged, never fatal.
    child.stderr.on("data", chunk => {
      const line = String(chunk).trim();
      if (line !== "") this.log(`mcp ${this.config.name}: ${line.slice(0, 200)}`);
    });
    child.on("error", error => this.fail(error.message));
    child.on("exit", code => this.fail(`exited (${code ?? "signal"})`));

    await this.request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agentbox", version: "1" },
      },
      START_TIMEOUT_MS
    );
    // The handshake is three steps and the third has no reply: a server may hold back
    // its tools until it knows the client is ready.
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const listed = (await this.request("tools/list", {}, START_TIMEOUT_MS)) as {
      tools?: { name?: string; description?: string; inputSchema?: Record<string, unknown> }[];
    };
    this.tools = (listed.tools ?? [])
      .filter((tool): tool is { name: string } & typeof tool => typeof tool.name === "string")
      .map(tool => ({
        name: `${this.config.name}${MCP_SEPARATOR}${tool.name}`,
        description: tool.description ?? `${tool.name}, from the ${this.config.name} server`,
        inputSchema:
          tool.inputSchema !== undefined && typeof tool.inputSchema === "object"
            ? tool.inputSchema
            : { type: "object", properties: {} },
      }));
    this.detail = `${this.tools.length} tool${this.tools.length === 1 ? "" : "s"}`;
    this.log(`mcp ${this.config.name}: ${this.detail}`);
    if (this.tools.length > TOOL_BUDGET_WARNING) {
      this.log(
        `mcp ${this.config.name}: ${this.tools.length} tools is a lot — every one of them ` +
          `is in every agent's prompt. Narrow it with an agent's tool list or a scope.`
      );
    }
  }

  /** Calls a tool by its bare (unprefixed) name and returns the result as text. */
  async call(bareName: string, input: unknown): Promise<string> {
    await this.ensureStarted();
    if (this.child === undefined || this.child.exitCode !== null) {
      throw new Error(`The ${this.config.name} MCP server is not running: ${this.detail}`);
    }
    const result = (await this.request("tools/call", {
      name: bareName,
      arguments: input ?? {},
    })) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    const text = (result.content ?? [])
      .map(block =>
        block.type === "text" && typeof block.text === "string"
          ? block.text
          : // Images and resources are named rather than dropped silently: an agent
            // told "(image)" knows to ask another way, one told nothing does not.
            `(${block.type ?? "content"} omitted — this bridge carries text)`
      )
      .join("\n");
    const body =
      text !== ""
        ? text
        : result.structuredContent !== undefined
          ? JSON.stringify(result.structuredContent)
          : "(the tool returned nothing)";
    if (result.isError === true) throw new Error(body);
    return body;
  }

  private request(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.config.name}: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private send(message: unknown): void {
    if (this.child === undefined) throw new Error(`${this.config.name} is not running`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let at = this.buffer.indexOf("\n");
    while (at >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line !== "") this.onMessage(line);
      at = this.buffer.indexOf("\n");
    }
  }

  private onMessage(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      // A server that writes prose to stdout is misbehaving, not fatal.
      this.log(`mcp ${this.config.name}: unreadable line ${line.slice(0, 120)}`);
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = this.pending.get(message.id);
    if (waiting === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error !== undefined) {
      waiting.reject(new Error(message.error.message ?? "the server refused"));
      return;
    }
    waiting.resolve(message.result ?? {});
  }

  /** Every in-flight request fails at once: a dead pipe answers nothing, ever. */
  private fail(detail: string): void {
    this.detail = detail;
    this.startPromise = undefined;
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new Error(`${this.config.name}: ${detail}`));
    }
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
    this.tools = [];
  }
}

/**
 * Every configured MCP server, and the tools they add up to.
 *
 * Lazy: nothing is spawned until a turn is actually built, so a CLI question does not
 * start somebody's ticket-system bridge as a side effect.
 */
export class McpManager {
  private readonly servers: McpServer[];

  constructor(
    configs: readonly McpServerConfig[],
    log: (line: string) => void = () => {}
  ) {
    this.servers = configs.map(config => new McpServer(config, log));
  }

  get configured(): boolean {
    return this.servers.length > 0;
  }

  /** Starts everything and resolves when each server has reported in, or failed to. */
  async ready(): Promise<void> {
    await Promise.all(this.servers.map(server => server.ensureStarted()));
  }

  /**
   * Kicks every server off and returns immediately.
   *
   * A turn must not wait on somebody's ticket-system bridge to boot. The first turn
   * after a restart therefore runs with whatever tools are known — none, at first —
   * while the servers come up behind it, and the turn after that has them. Trading a
   * cold first turn for a first turn that starts on time is the right way round: the
   * tools are an addition to what an agent can do, and an addition that delays the
   * answer is not obviously an improvement.
   */
  warm(): void {
    for (const server of this.servers) void server.ensureStarted();
  }

  /** Every tool from every started server, prefixed by server name. */
  tools(): McpTool[] {
    return this.servers.flatMap(server => server.listTools());
  }

  statuses(): McpServerStatus[] {
    return this.servers.map(server => server.status());
  }

  /** Whether there are too many external tools to put all of them in every prompt. */
  overBudget(): boolean {
    return this.tools().length > TOOL_BUDGET_WARNING;
  }

  /**
   * The catalog a model reads when the tools are behind the lookup pair.
   *
   * Servers with a one-line count, and each tool as a name plus a clamped first
   * sentence — enough to decide *which* tool to ask about, not enough to call one.
   * `pattern` filters by a plain substring over name and description, because a
   * regular expression from a model is a way to get an error instead of an answer.
   */
  describeTools(input: { server?: string; tool?: string; pattern?: string } = {}): string {
    const all = this.tools();
    if (all.length === 0) return "No MCP servers are connected.";

    // One named tool: the whole thing, schema included, which is what a caller needs.
    if (input.tool !== undefined && input.tool !== "") {
      const found = all.find(tool => tool.name === input.tool);
      if (found === undefined) return `No tool named ${input.tool}.`;
      return `${found.name}\n${found.description}\n\ninput schema:\n${JSON.stringify(found.inputSchema, null, 2)}`;
    }

    const needle = (input.pattern ?? "").toLowerCase();
    const matching = all.filter(tool => {
      if (input.server !== undefined && input.server !== "") {
        if (!tool.name.startsWith(`${input.server}${MCP_SEPARATOR}`)) return false;
      }
      if (needle === "") return true;
      return (
        tool.name.toLowerCase().includes(needle) ||
        tool.description.toLowerCase().includes(needle)
      );
    });
    if (matching.length === 0) return "Nothing matched. Call this with no arguments to see everything.";

    const byServer = new Map<string, McpTool[]>();
    for (const tool of matching) {
      const server = tool.name.slice(0, tool.name.indexOf(MCP_SEPARATOR));
      byServer.set(server, [...(byServer.get(server) ?? []), tool]);
    }
    return [...byServer.entries()]
      .map(([server, tools]) =>
        [
          `## ${server} (${tools.length})`,
          ...tools.map(tool => `- ${tool.name}: ${firstSentence(tool.description)}`),
        ].join("\n")
      )
      .join("\n\n");
  }

  /** Whether a tool name belongs to one of these servers. */
  owns(name: string): boolean {
    return this.serverFor(name) !== undefined;
  }

  private serverFor(name: string): McpServer | undefined {
    const at = name.indexOf(MCP_SEPARATOR);
    if (at <= 0) return undefined;
    const serverName = name.slice(0, at);
    return this.servers.find(server => server.config.name === serverName);
  }

  /** Runs a prefixed tool. Throws with a message worth relaying to the model. */
  async call(name: string, input: unknown): Promise<string> {
    const server = this.serverFor(name);
    if (server === undefined) throw new Error(`No MCP server offers ${name}.`);
    return server.call(name.slice(name.indexOf(MCP_SEPARATOR) + MCP_SEPARATOR.length), input);
  }

  stop(): void {
    for (const server of this.servers) server.stop();
  }
}
