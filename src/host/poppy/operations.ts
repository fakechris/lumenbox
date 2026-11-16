/**
 * The Operations extension, version 3: a Company asks for approval of exact terms before an action.
 *
 * The Company refuses the request and returns an operation (an API's 403 `approval_required`, an
 * MCP tool's error result with `structuredContent.operation`, or a conversation message's
 * `extensions.operations.operation`). Once the person approves that revision, the agent makes the
 * same request again with the approval: in the `Poppy-Approval` header at an API, in
 * `_meta["personalagentprotocol.org/approval"]` of the same tool call at MCP, or in a message's
 * `extensions.operations.approval` in a conversation. A declined card sends nothing — the extension
 * has no rejection message; the action simply isn't performed. A Company may still decline an
 * approval (`approval_declined`); that approval is never sent again.
 *
 * The person's answer is taken through LumenBox's own consent card, never from anything the
 * Company wrote; the card shows the Company's name and the revision's terms (extension §5).
 */

import { randomUUID } from "node:crypto";

export const OPERATIONS_EXTENSION = `"operations";v="3"`;

export interface Operation {
  operation_id: string;
  revision: string;
  summary?: string;
  terms: Record<string, unknown>;
  expires_at: string;
}

export interface Approval {
  operation_id: string;
  revision: string;
  approver: "user";
  approved_at: number;
  input_type: "tap";
  reference: string;
}

export interface Declined {
  operation_id: string;
  revision: string;
  reason?: string;
  alternative?: unknown;
}

const ID = /^[A-Za-z0-9_-]{1,256}$/;

/** An operation object, if `raw` is a well-formed one. */
export function asOperation(raw: unknown): Operation | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const op = raw as Record<string, unknown>;
  if (typeof op.operation_id !== "string" || !ID.test(op.operation_id)) return undefined;
  if (typeof op.revision !== "string" || !ID.test(op.revision)) return undefined;
  if (typeof op.terms !== "object" || op.terms === null || Array.isArray(op.terms)) return undefined;
  if (typeof op.expires_at !== "string" || Number.isNaN(Date.parse(op.expires_at))) return undefined;
  return {
    operation_id: op.operation_id,
    revision: op.revision,
    terms: op.terms as Record<string, unknown>,
    expires_at: op.expires_at,
    ...(typeof op.summary === "string" ? { summary: op.summary } : {}),
  };
}

/** The decline in a body, if it is one (an API's or MCP's `approval_declined`, or a message's `declined`). */
export function asDeclined(raw: unknown): Declined | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const body = raw as Record<string, unknown>;
  if (typeof body.operation_id !== "string" || typeof body.revision !== "string") return undefined;
  return { operation_id: body.operation_id, revision: body.revision, ...(typeof body.reason === "string" ? { reason: body.reason } : {}), ...(body.alternative !== undefined ? { alternative: body.alternative } : {}) };
}

/** What an API response asks or says about an operation. */
export function operationFromApi(status: number, body: unknown): { operation?: Operation; declined?: Declined } {
  if (status !== 403 || typeof body !== "object" || body === null) return {};
  const parsed = body as Record<string, unknown>;
  if (parsed.error === "approval_required") {
    const operation = asOperation(parsed.operation);
    return operation ? { operation } : {};
  }
  if (parsed.error === "approval_declined") {
    const declined = asDeclined(parsed);
    return declined ? { declined } : {};
  }
  return {};
}

/** What an MCP JSON-RPC response asks or says about an operation. */
export function operationFromMcp(body: unknown): { operation?: Operation; declined?: Declined } {
  const result = (body as { result?: { isError?: unknown; structuredContent?: Record<string, unknown> } } | null)?.result;
  if (result?.isError !== true || typeof result.structuredContent !== "object" || result.structuredContent === null) return {};
  const content = result.structuredContent;
  const operation = asOperation(content.operation);
  if (operation) return { operation };
  if (content.error === "approval_declined") {
    const declined = asDeclined(content);
    return declined ? { declined } : {};
  }
  return {};
}

/** A user approval of this revision, given now. The reference is new each time, so two Companies never share one. */
export function approvalOf(op: Operation, now = Date.now()): Approval {
  return { operation_id: op.operation_id, revision: op.revision, approver: "user", approved_at: Math.floor(now / 1000), input_type: "tap", reference: `apr_${randomUUID().replace(/-/g, "")}` };
}

/** The `Poppy-Approval` header: a Dictionary Structured Field (RFC 9651). */
export function approvalHeader(approval: Approval): string {
  const str = (value: string) => `"${value.replace(/["\\]/g, "")}"`;
  return [
    `operation_id=${str(approval.operation_id)}`,
    `revision=${str(approval.revision)}`,
    `approver=${str(approval.approver)}`,
    `approved_at=${approval.approved_at}`,
    `input_type=${str(approval.input_type)}`,
    `reference=${str(approval.reference)}`,
  ].join(", ");
}

/** The same MCP `tools/call`, with the approval in `_meta` (extension §6). */
export function withMcpApproval(body: string, approval: Approval): string {
  const call = JSON.parse(body) as { params?: Record<string, unknown>; id?: unknown };
  const params = call.params ?? {};
  const meta = typeof params._meta === "object" && params._meta !== null ? (params._meta as Record<string, unknown>) : {};
  return JSON.stringify({ ...call, id: `${String(call.id ?? "call")}-approved`, params: { ...params, _meta: { ...meta, "personalagentprotocol.org/approval": approval } } });
}

/**
 * What the person reads on the card: the Company's name, its summary, and the terms themselves,
 * so a summary that says less than the terms can be caught. Shown as text, never rendered: a
 * summary must not carry a link or an image into the decision (extension §3).
 */
export function consentDescription(op: Operation, company: string): string {
  const lines = [`${company} asks for approval (operation ${op.operation_id}, revision ${op.revision}):`];
  if (op.summary) lines.push("", op.summary);
  lines.push("", "Terms:", JSON.stringify(op.terms, null, 2), "", `Approval accepted until ${op.expires_at}.`);
  return lines.join("\n");
}
