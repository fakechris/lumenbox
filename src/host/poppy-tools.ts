/**
 * Poppy protocol tools for agent use.
 *
 * These tools expose Poppy capabilities to the agent in a way that
 * respects the security boundary (spec 10.1): tokens and keys stay
 * in the manager, never in model context.
 *
 * - PoppyDiscover: Check if a website supports the Poppy protocol
 * - PoppyConverse: Have a conversation with a Company's agent
 * - PoppyStatus: See which Companies the agent has sessions with
 */

import type { PoppyManager } from "./poppy/manager.ts";
import { parseOperation, policyLevel, consentDescription, type Operation, type OperationDecision } from "./poppy/operations.ts";
import type { ConversationEvent } from "./poppy/conversations.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { poppyBrowserJoinUrl } from "./poppy-browser.ts";

/** The Poppy tools by name: offered only to a turn whose host has Poppy on (docs/poppy.md). */
export const POPPY_TOOLS: ReadonlySet<string> = new Set(["PoppyDiscover", "PoppyConverse", "PoppyStatus"]);

// ── Tool definitions ──────────────────────────────────────────

export function poppyToolDefinitions(): Anthropic.Tool[] {
  return [
    {
      name: "PoppyDiscover",
      description:
        "Check whether a website supports the Poppy protocol. Returns the Company's " +
        "name, supported channels, and whether sign-in or commerce (UCP) is available. " +
        "Use this before trying to converse with a Company's agent.",
      input_schema: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "The domain to check, e.g. allbirds.com",
          },
        },
        required: ["domain"],
      },
    },
    {
      name: "PoppyConverse",
      description:
        "Send a message to a Company's agent through the Poppy conversation protocol. " +
        "The Company must support Poppy and have a conversation endpoint. The response " +
        "streams back and may include operations that need your approval.\n\n" +
        "Use PoppyDiscover first to check if the Company supports conversations.",
      input_schema: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "The Company's domain, e.g. allbirds.com",
          },
          message: {
            type: "string",
            description: "The message to send, on behalf of the user.",
          },
          conversation_id: {
            type: "string",
            description: "Optional conversation ID to continue an existing conversation.",
          },
        },
        required: ["domain", "message"],
      },
    },
    {
      name: "PoppyStatus",
      description:
        "See the current state of Poppy protocol support: which Companies have active " +
        "sessions, which have stored tokens, and the agent's identity.",
      input_schema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

// ── Tool dispatch ─────────────────────────────────────────────

export interface PoppyToolContext {
  manager: PoppyManager;
  /** Called when an operation arrives during a conversation. */
  onOperation?: (op: Operation) => void;
  /**
   * Request a confirmation from the user through the policy gate (consent card).
   * When present, Company operations are automatically put to the user for approval.
   */
  requestConfirmation?: (input: {
    agentId: string;
    agentName: string;
    description: string;
    action?: string;
  }) => { id: string };
  /** Agent identity for consent card attribution. */
  agentId?: string;
  agentName?: string;
  log?: (line: string) => void;
}

export interface PoppyToolResult {
  text: string;
  isError?: boolean;
  /** An operation that arrived and needs user approval. */
  pendingOperation?: Operation;
}

export async function dispatchPoppyTool(
  name: string,
  input: Record<string, unknown>,
  ctx: PoppyToolContext,
): Promise<PoppyToolResult> {
  if (!ctx.manager.ready) {
    return { text: "The Poppy protocol is not available (agent identity not initialized).", isError: true };
  }

  switch (name) {
    case "PoppyDiscover":
      return poppyDiscover(String(input.domain ?? ""), ctx);
    case "PoppyConverse":
      return poppyConverse(
        String(input.domain ?? ""),
        String(input.message ?? ""),
        typeof input.conversation_id === "string" ? input.conversation_id : undefined,
        ctx,
      );
    case "PoppyStatus":
      return poppyStatus(ctx);
    default:
      return { text: `Unknown Poppy tool: ${name}`, isError: true };
  }
}

// ── PoppyDiscover ─────────────────────────────────────────────

async function poppyDiscover(domain: string, ctx: PoppyToolContext): Promise<PoppyToolResult> {
  if (!domain) return { text: "A domain is required.", isError: true };

  const result = await ctx.manager.discoverWithAuth(domain);
  if (!result) {
    return { text: `${domain} does not publish a Poppy protocol document (no /.well-known/poppy.json found).` };
  }

  const { company, authServer } = result;
  const lines: string[] = [
    `# ${company.name} (${company.domain})`,
    `Protocol version: ${company.protocolVersion}`,
  ];

  // Channels
  const channels: string[] = [];
  if (company.agentProtocols?.length) {
    for (const p of company.agentProtocols) {
      channels.push(`  - ${p.type}: ${p.endpoint}${p.description ? ` — ${p.description}` : ""}`);
    }
  }
  if (company.apis?.length) {
    for (const api of company.apis) {
      channels.push(`  - API (${api.type}): ${api.url}${api.description ? ` — ${api.description}` : ""}`);
    }
  }
  if (company.web) {
    if (company.web.browserSessionEndpoint) channels.push(`  - Browser Join available`);
  }
  if (channels.length > 0) {
    lines.push(`\nChannels:\n${channels.join("\n")}`);
  }

  // Auth
  if (company.auth && !company.auth.disabled) {
    lines.push(`\nSign-in: available (issuer: ${company.auth.issuer})`);
    if (company.auth.scopes) {
      const scopeList = Object.entries(company.auth.scopes)
        .map(([k, v]) => `  - ${k}: ${v}`)
        .join("\n");
      lines.push(`Scopes:\n${scopeList}`);
    }
    if (authServer) {
      lines.push(`Auth server: discovered (${authServer.issuer})`);
    }
  }

  // Extensions
  if (company.extensions) {
    const extNames = Object.keys(company.extensions);
    if (extNames.length > 0) {
      lines.push(`\nExtensions:\n${extNames.map(name => `  - ${name}`).join("\n")}`);
    }
  }

  return { text: lines.join("\n") };
}

// ── PoppyConverse ─────────────────────────────────────────────

async function poppyConverse(
  domain: string,
  message: string,
  conversationId: string | undefined,
  ctx: PoppyToolContext,
): Promise<PoppyToolResult> {
  if (!domain) return { text: "A domain is required.", isError: true };
  if (!message) return { text: "A message is required.", isError: true };

  // Check if the Company supports conversations.
  const ep = await ctx.manager.conversationEndpointFor(domain);
  if (!ep) {
    return { text: `${domain} does not support Poppy conversations (no conversation protocol found).`, isError: true };
  }

  // Collect responses.
  const messages: string[] = [];
  let pendingOp: Operation | undefined;
  let error: string | undefined;

  const events: ConversationEvent[] = [];
  await new Promise<void>((resolve) => {
    const handleEvent = (event: ConversationEvent): void => {
      events.push(event);
      switch (event.type) {
        case "message":
          messages.push(event.message.content);
          break;
        case "operation": {
          const op = parseOperation(
            {
              id: event.operation.id,
              type: event.operation.type,
              description: event.operation.description,
              ...(event.operation.parameters ?? {}),
            },
            ep.endpoint,
          );
          pendingOp = op;
          ctx.onOperation?.(op);

          // Auto-request confirmation through the policy gate when available.
          if (ctx.requestConfirmation && event.operation.requiresApproval) {
            const desc = consentDescription(op);
            const level = policyLevel(op);
            ctx.requestConfirmation({
              agentId: ctx.agentId ?? "poppy",
              agentName: ctx.agentName ?? "Poppy",
              description: desc,
              action: `Poppy operation (${op.type}, L${level}): ${domain}`,
            });
            ctx.log?.(`Requested user confirmation for operation ${op.id} (${op.type}, L${level})`);
          }
          break;
        }
        case "error":
          error = event.error;
          break;
        case "done":
          resolve();
          break;
      }
    };

    ctx.manager.converse(domain, message, handleEvent, { conversationId })
      .then(ctrl => {
        if (!ctrl) {
          error = "Could not start conversation (no session or endpoint)";
          resolve();
        }
      })
      .catch(err => {
        error = err instanceof Error ? err.message : String(err);
        resolve();
      });

    // Timeout: don't hang indefinitely.
    setTimeout(() => resolve(), 60_000);
  });

  const parts: string[] = [];
  if (messages.length > 0) {
    parts.push(messages.join("\n\n"));
  }
  if (pendingOp) {
    const level = policyLevel(pendingOp);
    parts.push(
      `\n---\n⚠️ The Company requests an operation (policy level L${level}):\n\n` +
      consentDescription(pendingOp)
    );
  }
  if (error) {
    parts.push(`\n[Error: ${error}]`);
  }
  if (parts.length === 0) {
    return { text: "(No response from the Company's agent.)" };
  }

  return {
    text: parts.join("\n"),
    pendingOperation: pendingOp,
  };
}

// ── PoppyStatus ───────────────────────────────────────────────

async function poppyStatus(ctx: PoppyToolContext): Promise<PoppyToolResult> {
  const status = ctx.manager.status();
  const lines: string[] = [
    `# Poppy Protocol Status`,
    `Agent ID: ${status.clientId ?? "(not initialized)"}`,
    `Ready: ${status.ready}`,
  ];

  if (status.activeSessions.length > 0) {
    lines.push(`\nActive Sessions (${status.activeSessions.length}):`);
    for (const domain of status.activeSessions) {
      lines.push(`  - ${domain}`);
    }
  }

  if (status.tokens.length > 0) {
    lines.push(`\nStored Tokens (${status.tokens.length}):`);
    for (const t of status.tokens) {
      lines.push(`  - ${t.issuer}: access=${t.hasAccess}, refresh=${t.hasRefresh}`);
    }
  }

  if (status.negativeCache.length > 0) {
    lines.push(`\nDomains without Poppy (${status.negativeCache.length}):`);
    for (const domain of status.negativeCache.slice(0, 10)) {
      lines.push(`  - ${domain}`);
    }
    if (status.negativeCache.length > 10) {
      lines.push(`  ... and ${status.negativeCache.length - 10} more`);
    }
  }

  if (status.pendingAuthFlows > 0) {
    lines.push(`\nPending sign-in flows: ${status.pendingAuthFlows}`);
  }

  return { text: lines.join("\n") };
}

// ── The seam tools.ts calls ───────────────────────────────────

/** What a tool call brings: the subset of the turn's ToolContext Poppy reads. */
export interface PoppyCallContext {
  poppyManager?: PoppyManager;
  agent: { id: string; profile: { name: string } };
  policy?: { requestConfirmation(input: { agentId: string; agentName: string; description: string; action?: string }): { id: string } };
}

/** One Poppy tool call, refused plainly when Poppy is off on this host. */
export async function poppyCall(name: string, input: Record<string, unknown>, context: PoppyCallContext): Promise<{ text: string; isError?: boolean }> {
  if (context.poppyManager === undefined) return { text: "The Poppy protocol is not enabled on this installation.", isError: true };
  // The manager is made lazily, on the first fetch; a Poppy tool may be the first thing to need it.
  await context.poppyManager.init().catch(() => undefined);
  const result = await dispatchPoppyTool(name, input, {
    manager: context.poppyManager,
    agentId: context.agent.id,
    agentName: context.agent.profile.name,
    ...(context.policy !== undefined ? { requestConfirmation: (request: Parameters<NonNullable<PoppyToolContext["requestConfirmation"]>>[0]) => context.policy!.requestConfirmation(request) } : {}),
    log: line => console.error(`[poppy] ${line}`),
  });
  return { text: result.text, ...(result.isError ? { isError: true } : {}) };
}

/**
 * Browser Join (spec 8.3) before a page opens: when the site joins browsers to a Poppy session,
 * open its one-time join URL first. A failed join is not fatal; the page opens without it.
 */
export async function poppyJoin(manager: PoppyManager | undefined, url: string, open: (joinUrl: string) => Promise<unknown>): Promise<void> {
  if (manager?.ready !== true) return;
  const joinUrl = await poppyBrowserJoinUrl(manager, url);
  if (joinUrl !== undefined) await open(joinUrl).catch(() => undefined);
}
