/**
 * The side door: this installation, as an MCP server.
 *
 * The two other surfaces answer "make my agents do something" for a person — a chat
 * from a phone, a workshop in a browser. This one answers it for *somebody else's
 * agent*: a Claude Code session, an IDE, whatever a person already works in. The
 * argument for building it is the same argument that says not to build a better coding
 * harness — meet people where they are, and be the thing their agent reaches for
 * rather than the thing competing for their attention.
 *
 * **What it offers is deliberately narrow, and it is the part nobody else has.** Not
 * "here are all our tools": a persistent Linux box with a desktop, a team that can be
 * given work and asked about later, and the organisation layer around both. An
 * external agent gets a computer and a workforce; it does not get our memory, our
 * files wholesale, or the ability to reconfigure the installation.
 *
 * **Every call has an owner.** The token is issued to a principal, so an outside
 * agent's work is attributed, billed, budgeted and audited exactly as a person's is —
 * and when it asks for something that needs consent, the approval card goes to the
 * phone of the person whose token it is. That is the whole differentiator: a bare MCP
 * wrapper hands an agent capability with nobody's name on it.
 *
 * Hand-rolled JSON-RPC over HTTP, like the client half and for the same reason: three
 * methods is small enough to own, and owning it keeps the dependency count where it is.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Prefix so a token is recognisable in a log or a config file as ours. */
const TOKEN_PREFIX = "lmbx_";

export interface McpAccessToken {
  token: string;
  /** Whose it is. Every call made with it is attributed here. */
  principalId: string;
  label: string;
  createdAt: string;
}

export function mintMcpToken(principalId: string, label: string): McpAccessToken {
  return {
    token: `${TOKEN_PREFIX}${randomBytes(24).toString("hex")}`,
    principalId,
    label: label.trim().slice(0, 60) || "unnamed",
    createdAt: new Date().toISOString(),
  };
}

/** Constant-time, because this compares a secret against attacker-supplied input. */
function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function principalForToken(
  presented: string | undefined,
  tokens: readonly McpAccessToken[]
): string | undefined {
  if (presented === undefined || presented === "") return undefined;
  return tokens.find(entry => sameToken(entry.token, presented))?.principalId;
}

/** One tool, as this server describes and runs it. */
export interface McpServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Annotations are declared, never guessed.
   *
   * The reference implementation infers them from a regular expression over the tool's
   * name, which reads `get_and_delete_thing` as read-only and `download` as safe. Our
   * tools are ours; we know which ones change the world and say so.
   */
  readOnly: boolean;
  run: (input: Record<string, unknown>, principalId: string) => Promise<string>;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Bodies are small by construction; anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Serves one MCP request. Returns true when it handled the route.
 *
 * Mounted inside the existing web server rather than given a port of its own: it is
 * the same installation with the same identities, and a second listener would be a
 * second thing to secure, publish and remember.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    tools: readonly McpServerTool[];
    principalFor: (presented: string | undefined) => string | undefined;
    log: (line: string) => void;
    /** Which path this serves. `/mcp` is the person's side door; `/mcp/r/<key>` a route (docs/33). */
    path?: string;
    /** Who answers `initialize` as. */
    serverName?: string;
  }
): Promise<boolean> {
  if (req.url?.split("?")[0] !== (deps.path ?? "/mcp")) return false;

  const send = (status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  if (req.method !== "POST") {
    send(405, { error: "MCP is a POST endpoint." });
    return true;
  }

  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
  const principalId = deps.principalFor(bearer);
  if (principalId === undefined) {
    // No hint about whether the token was absent, malformed or simply unknown: the
    // difference is only useful to somebody guessing.
    send(401, { error: "This endpoint needs an access token issued to a person." });
    return true;
  }

  let request: JsonRpcRequest;
  try {
    request = (await readBody(req)) as JsonRpcRequest;
  } catch (error) {
    send(400, { error: error instanceof Error ? error.message : "unreadable body" });
    return true;
  }

  const id = request.id ?? null;
  const reply = (result: unknown) => send(200, { jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) =>
    send(200, { jsonrpc: "2.0", id, error: { code, message } });

  switch (request.method) {
    case "initialize":
      reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: deps.serverName ?? "lumenbox", version: "1" },
      });
      return true;

    // No reply by protocol; answered with an empty 200 so a client is not left waiting.
    case "notifications/initialized":
      send(200, {});
      return true;

    case "tools/list":
      reply({
        tools: deps.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            readOnlyHint: tool.readOnly,
            destructiveHint: !tool.readOnly,
            openWorldHint: true,
          },
        })),
      });
      return true;

    case "tools/call": {
      const name = String(request.params?.name ?? "");
      const tool = deps.tools.find(entry => entry.name === name);
      if (tool === undefined) {
        fail(-32602, `No tool named ${name}.`);
        return true;
      }
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = await tool.run(args, principalId);
        reply({ content: [{ type: "text", text }] });
      } catch (error) {
        // An MCP error result, not a transport error: the caller's agent should read
        // this and decide, the same as any other failed tool.
        const detail = error instanceof Error ? error.message : String(error);
        deps.log(`mcp server: ${name} failed for ${principalId}: ${detail}`);
        reply({ content: [{ type: "text", text: detail }], isError: true });
      }
      return true;
    }

    default:
      fail(-32601, `Unsupported method: ${String(request.method)}`);
      return true;
  }
}
