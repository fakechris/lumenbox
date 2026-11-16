/**
 * The Poppy tools an agent uses (docs/poppy.md).
 *
 * Poppy is used when the agent asks, not on every page: it discovers a Company, sends signed
 * requests to that Company's destinations, and talks with its agent. Keys, tokens, Session JWTs and
 * User IDs stay in the manager and never reach model context (spec 10.2); everything a Company
 * returns is content from the Company, not instructions (10.1).
 *
 * - PoppyDiscover: is this a Poppy Company, and what does it offer — conversations, APIs, UCP
 *   commerce services, Browser Join, sign-in (not available yet).
 * - PoppyRequest: one signed HTTPS request to a destination of a Company. A UCP service gets this
 *   agent's platform profile on every request. When the Company asks for approval of an operation,
 *   the person gets a consent card; their approval is sent back as the Operations extension says.
 * - PoppyConverse: a message to the Company's agent, and its reply (spec 8).
 * - PoppyStatus: this agent's Sessions and sign-ins here.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { poppyBrowserJoinUrl } from "./poppy-browser.ts";
import { PoppyRefused } from "./poppy/http.ts";
import type { PoppyManager } from "./poppy/manager.ts";
import { consentDescription, type Operation } from "./poppy/operations.ts";

/** The Poppy tools by name: offered only to a turn whose host has Poppy on (docs/poppy.md). */
export const POPPY_TOOLS: ReadonlySet<string> = new Set(["PoppyDiscover", "PoppyRequest", "PoppyConverse", "PoppyStatus"]);

// ── Tool definitions ──────────────────────────────────────────

export function poppyToolDefinitions(): Anthropic.Tool[] {
  return [
    {
      name: "PoppyDiscover",
      description:
        "Check whether a company supports the Personal Agent Protocol (Poppy), before acting for the user at its website or API. " +
        "Says what it offers agents: a conversation with its agent, APIs, UCP commerce services (cart, checkout, orders), " +
        "Browser Join. A Poppy company treats requests carrying this agent's signed Session as a personal agent acting for a " +
        "user rather than an anonymous bot. Not a Poppy company: use the ordinary web tools.",
      input_schema: { type: "object", properties: { domain: { type: "string", description: "The company's domain, e.g. allbirds.com" } }, required: ["domain"] },
    },
    {
      name: "PoppyRequest",
      description:
        "Send one HTTPS request to a Poppy company with this agent's signed Session — only to its destinations: pages on " +
        "exactly its domain, and endpoints its poppy.json or UCP profile lists (PoppyDiscover shows them); anything else is " +
        "refused. For a UCP service (MCP transport), send a JSON-RPC body such as " +
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_checkout","arguments":{...}}}; the platform ' +
        "profile is added for you. If the company asks for approval of an action, the person is asked; the approval goes " +
        "back by itself and you are told the outcome — never approve or retry it yourself. There is no payment here: to pay, " +
        "give the person the checkout's continue_url. You cannot set Authorization, Cookie, Poppy-* or UCP-Agent headers.",
      input_schema: {
        type: "object",
        properties: {
          method: { type: "string", description: "GET, POST, PUT, PATCH or DELETE. Default GET." },
          url: { type: "string", description: "An https URL that is one of the company's destinations." },
          body: { description: "The request body: a JSON value, or a string sent as it is." },
          headers: { type: "object", description: "Extra request headers, e.g. Accept." },
          domain: { type: "string", description: "The company's domain, when the URL is on another host (a UCP service on myshopify.com for allbirds.com)." },
        },
        required: ["url"],
      },
    },
    {
      name: "PoppyConverse",
      description:
        "Send a message to a Poppy company's own agent and get its reply. Start a conversation without conversation_id; " +
        "continue it by passing the conversation_id from the earlier reply. Write as the user's agent, saying what the " +
        "user wants. If the company's agent asks for approval of an action, the person is asked and the approval goes " +
        "back by itself; you are told the outcome.",
      input_schema: {
        type: "object",
        properties: {
          domain: { type: "string", description: "The company's domain, e.g. allbirds.com" },
          message: { type: "string", description: "What to say, on the user's behalf." },
          conversation_id: { type: "string", description: "To continue a conversation started earlier." },
        },
        required: ["domain", "message"],
      },
    },
    {
      name: "PoppyStatus",
      description: "This agent's Poppy state here: its identity, the companies it has Sessions with, and sign-ins (none yet).",
      input_schema: { type: "object", properties: {} },
    },
  ];
}

// ── Tool dispatch ─────────────────────────────────────────────

export interface PoppyToolContext {
  manager: PoppyManager;
  /** Whom the call acts for: the agent's id (see PoppyManager). */
  who: string;
  /** The conversation the call came from, where the outcome of an operation is told. */
  conversation: string;
  /**
   * Puts a Company's operation to the person as a consent card. Absent means there is nobody to
   * ask here, and the operation is not approved.
   */
  requestConfirmation?: (input: { agentId: string; agentName: string; description: string; action?: string }) => { id: string };
  agentName?: string;
  log?: (line: string) => void;
  /** How long to wait for a conversation's reply. Tests shorten it. */
  timeoutMs?: number;
}

export interface PoppyToolResult {
  text: string;
  isError?: boolean;
}

export async function dispatchPoppyTool(name: string, input: Record<string, unknown>, ctx: PoppyToolContext): Promise<PoppyToolResult> {
  if (!ctx.manager.ready) return { text: "The Poppy protocol is not available (agent identity not initialized).", isError: true };
  try {
    switch (name) {
      case "PoppyDiscover":
        return await poppyDiscover(String(input.domain ?? "").trim(), ctx);
      case "PoppyRequest":
        return await poppyRequestTool(input, ctx);
      case "PoppyConverse":
        return await poppyConverse(String(input.domain ?? "").trim(), String(input.message ?? ""), typeof input.conversation_id === "string" ? input.conversation_id : undefined, ctx);
      case "PoppyStatus":
        return poppyStatus(ctx);
      default:
        return { text: `Unknown Poppy tool: ${name}`, isError: true };
    }
  } catch (error) {
    const refused = error instanceof PoppyRefused;
    return { text: `${refused ? "Refused" : "Failed"}: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

// ── PoppyDiscover ─────────────────────────────────────────────

async function poppyDiscover(domain: string, ctx: PoppyToolContext): Promise<PoppyToolResult> {
  if (!domain) return { text: "A domain is required.", isError: true };
  const found = await ctx.manager.destinationsFor(domain);
  if (!found) return { text: `${domain} is not a Poppy company (no usable /.well-known/poppy.json). Use the ordinary web tools there.` };
  const { company } = found;
  const lines = [`# ${company.name} (${company.domain})`, `Protocol version: ${company.protocolVersion}`, "", "Destinations (PoppyRequest sends only to these):", `  - pages on https://${company.domain}/`];
  for (const protocol of company.agentProtocols ?? []) lines.push(`  - conversation (${protocol.type}): ${protocol.endpoint}${protocol.type === "poppy" ? " — use PoppyConverse" : ""}`);
  for (const api of company.apis ?? []) lines.push(`  - API (${api.type}): ${api.url}${api.description ? ` — ${api.description}` : ""}`);
  if (company.tasksEndpoint) lines.push(`  - tasks: ${company.tasksEndpoint}`);
  const ucp = ctx.manager.ucpProfileOf(company.domain);
  if (ucp) {
    lines.push("", `UCP commerce (version ${ucp.version}) — use PoppyRequest with domain "${company.domain}":`);
    for (const service of ucp.services) lines.push(`  - ${service.name} over ${service.transport}: ${service.endpoint}`);
    lines.push("  Pay: there is no payment here; give the person the checkout's continue_url.");
  }
  if (company.web?.browserSessionEndpoint) lines.push("", "Browser Join: opening its pages in the browser joins this agent's Session.");
  if (company.auth?.scopes && !company.auth.disabled) {
    lines.push("", "Sign-in is offered, but this agent cannot sign in yet: everything here is signed out. Scopes it offers:");
    for (const [scope, description] of Object.entries(company.auth.scopes)) lines.push(`  - ${scope}: ${description}`);
  }
  return { text: lines.join("\n") };
}

// ── PoppyRequest ──────────────────────────────────────────────

async function poppyRequestTool(input: Record<string, unknown>, ctx: PoppyToolContext): Promise<PoppyToolResult> {
  const url = String(input.url ?? "").trim();
  if (!url) return { text: "A url is required.", isError: true };
  const method = String(input.method ?? "GET").toUpperCase();
  const body = input.body === undefined ? undefined : typeof input.body === "string" ? input.body : JSON.stringify(input.body);
  const headers = typeof input.headers === "object" && input.headers !== null ? Object.fromEntries(Object.entries(input.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {};
  const domain = typeof input.domain === "string" && input.domain.trim() !== "" ? input.domain.trim() : undefined;
  const answer = await ctx.manager.request(ctx.who, { method, url, ...(body !== undefined ? { body } : {}), headers, ...(domain !== undefined ? { domain } : {}) });
  const company = (domain ?? new URL(url).hostname).toLowerCase();
  const head = `HTTP ${answer.status}${answer.contentType ? ` (${answer.contentType})` : ""}`;
  if (answer.operation) {
    const via = { kind: answer.transport, method, url, ...(body !== undefined ? { body } : {}), headers } as const;
    return { text: `${head}. Not done: ${company} asks for approval first.\n${askAbout(answer.operation, company, via, { ...(answer.signIn !== undefined ? { signIn: answer.signIn } : {}) }, ctx)}` };
  }
  if (answer.declined) return { text: `${head}. ${company} declined the approval${answer.declined.reason ? `: ${answer.declined.reason}` : "."} Nothing was performed; do not send it again.` };
  return { text: `${head}\n\n${answer.body}`, ...(answer.status >= 400 ? { isError: true } : {}) };
}

// ── PoppyConverse ─────────────────────────────────────────────

const CONVERSE_TIMEOUT_MS = 60_000;

async function poppyConverse(domain: string, message: string, conversationId: string | undefined, ctx: PoppyToolContext): Promise<PoppyToolResult> {
  if (!domain) return { text: "A domain is required.", isError: true };
  if (!message.trim()) return { text: "A message is required.", isError: true };
  const turn = await ctx.manager.converse(ctx.who, domain, { text: message }, conversationId, Date.now() + (ctx.timeoutMs ?? CONVERSE_TIMEOUT_MS));
  const parts = [`Conversation ${turn.conversationId} with ${domain} (pass it as conversation_id to continue).`];
  for (const said of turn.messages) {
    const who = said.author.type === "human" ? `${said.author.name ?? "a person"} at ${domain}` : `${domain}'s agent`;
    parts.push(`${who}: ${said.text ?? ""}${said.data !== undefined ? `\n${JSON.stringify(said.data)}` : ""}`);
  }
  for (const op of turn.operations) parts.push(askAbout(op, domain, { kind: "conversation", conversationId: turn.conversationId }, { ...(turn.signIn !== undefined ? { signIn: turn.signIn } : {}) }, ctx));
  for (const declined of turn.declined) parts.push(`${domain} declined approval of ${declined.operation_id}${declined.reason ? `: ${declined.reason}` : "."} Nothing was performed.`);
  for (const reason of turn.userRequested) parts.push(`${domain} asks to talk with the person directly${reason ? `: ${reason}` : "."} Tell them.`);
  for (const error of turn.authorization) parts.push(`${domain} needs the person signed in (${error}); this agent cannot sign in yet.`);
  if (turn.readError) parts.push(`Reading the rest of the reply failed (${turn.readError}); continue the conversation to read it.`);
  else if (turn.working) parts.push(`${domain} is still working on it; continue the conversation later to read the rest.`);
  if (turn.closed) parts.push("The conversation is closed.");
  if (turn.messages.length === 0 && !turn.working) parts.push("(No reply.)");
  return { text: parts.join("\n\n") };
}

/**
 * A Company asked for approval of an operation. It is put to the person as a consent card naming
 * the Company and the revision's terms; their answer goes back when they give it
 * (PoppyManager.settleApproval). Nothing here approves anything: the agent cannot, and is told so.
 */
function askAbout(op: Operation, domain: string, via: Parameters<PoppyManager["awaitDecision"]>[1]["via"], signIn: { signIn?: string }, ctx: PoppyToolContext): string {
  const terms = consentDescription(op, domain);
  if (ctx.requestConfirmation === undefined) {
    return `---\n${terms}\n\nThere is nobody here to approve it, so it is not approved and nothing was performed. Say so to whoever asked.`;
  }
  // The gate folds cards with the same words into one approval: the description names the Company,
  // the operation and its revision, so two requests never share one answer.
  const approval = ctx.requestConfirmation({ agentId: ctx.who, agentName: ctx.agentName ?? "Poppy", description: terms, action: `approve ${domain}'s operation ${op.operation_id}` });
  // Under the sign-in the request went with, and able to put the next revision to the person the same way.
  const reask = (next: Operation) => askAbout(next, domain, via, signIn, ctx);
  ctx.manager.awaitDecision(approval.id, { who: ctx.who, domain, operation: op, via, agentId: ctx.who, conversation: ctx.conversation, reask }, signIn);
  ctx.log?.(`asked the person about operation ${op.operation_id} from ${domain}`);
  return `---\n${terms}\n\nThis is waiting for the person to approve or decline. If they approve, the approval goes to ${domain} by itself and you will be told what came of it. Do not approve it, retry it, or ask again.`;
}

// ── PoppyStatus ───────────────────────────────────────────────

function poppyStatus(ctx: PoppyToolContext): PoppyToolResult {
  const status = ctx.manager.status(ctx.who);
  const lines = ["# Poppy", `Agent ID: ${status.clientId ?? "(not initialized)"}`];
  lines.push(status.activeSessions.length > 0 ? `Sessions with: ${status.activeSessions.join(", ")}` : "No Sessions yet.");
  if (status.tokens.length > 0) for (const t of status.tokens) lines.push(`Signed in at ${t.domain} (${t.issuer}): access=${t.hasAccess}, refresh=${t.hasRefresh}`);
  else lines.push("Not signed in anywhere (sign-in is not available yet).");
  return { text: lines.join("\n") };
}

// ── The seam tools.ts calls ───────────────────────────────────

/** What a tool call brings: the subset of the turn's ToolContext Poppy reads. */
export interface PoppyCallContext {
  poppyManager?: PoppyManager;
  agent: { id: string; profile: { name: string } };
  conversation?: string;
  policy?: { requestConfirmation(input: { agentId: string; agentName: string; description: string; action?: string }): { id: string } };
}

/** One Poppy tool call, refused plainly when Poppy is off on this host. */
export async function poppyCall(name: string, input: Record<string, unknown>, context: PoppyCallContext): Promise<{ text: string; isError?: boolean }> {
  if (context.poppyManager === undefined) return { text: "The Poppy protocol is not enabled on this installation.", isError: true };
  await context.poppyManager.init().catch(() => undefined);
  const result = await dispatchPoppyTool(name, input, {
    manager: context.poppyManager,
    who: context.agent.id,
    conversation: context.conversation ?? "main",
    agentName: context.agent.profile.name,
    ...(context.policy !== undefined ? { requestConfirmation: (request: Parameters<NonNullable<PoppyToolContext["requestConfirmation"]>>[0]) => context.policy!.requestConfirmation(request) } : {}),
    log: line => console.error(`[poppy] ${line}`),
  });
  return { text: result.text, ...(result.isError ? { isError: true } : {}) };
}

/**
 * Browser Join (spec 6) before a page opens, at a Company already discovered: open its one-time
 * join URL first. A failed join is not fatal; the page opens without it.
 */
export async function poppyJoin(manager: PoppyManager | undefined, who: string, url: string, open: (joinUrl: string) => Promise<unknown>): Promise<void> {
  if (manager?.ready !== true) return;
  const joinUrl = await poppyBrowserJoinUrl(manager, who, url);
  if (joinUrl !== undefined) await open(joinUrl).catch(() => undefined);
}
