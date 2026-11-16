/**
 * Poppy Operations (spec section 8.4).
 *
 * When a Company's agent requests an action that has consequences — placing
 * an order, booking a flight, changing account settings — it sends an
 * Operation. The personal agent presents this to the user for approval
 * before executing it.
 *
 * This maps naturally to agentbox's consent cards (policy gate L3–L4).
 */

import type { PoppySession } from "./session.ts";

// ── Types ─────────────────────────────────────────────────────

export interface Operation {
  /** Unique ID assigned by the Company. */
  id: string;
  /** What kind of action this is (checkout, booking, account_update, etc.). */
  type: string;
  /** Human-readable description for the user. */
  description: string;
  /** The endpoint to POST approval/rejection to. */
  endpoint: string;
  /** Structured parameters the Company sent. */
  parameters: Record<string, unknown>;
  /** Whether irreversible (maps to L4+ in the policy gate). */
  irreversible: boolean;
  /** Whether it involves personal data. */
  personalData: boolean;
  /** Display information. */
  display?: {
    title?: string;
    summary?: string;
    details?: Array<{ label: string; value: string }>;
    amount?: string;
    currency?: string;
  };
  /** When the operation expires. */
  expiresAt?: number;
}

export interface OperationDecision {
  approved: boolean;
  reason?: string;
}

export interface OperationResult {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Maps an Operation to a policy gate level.
 *
 * The mapping follows the analysis document's table (section 6.3 D):
 * - irreversible → L4 (needs explicit user confirmation)
 * - personal_data → L3 (needs user awareness)
 * - everything else → L2 (logged, not blocked)
 */
export function policyLevel(op: Operation): 2 | 3 | 4 {
  if (op.irreversible) return 4;
  if (op.personalData) return 3;
  return 2;
}

/**
 * Builds a consent card description from an Operation.
 *
 * The description is what the user sees when asked to approve.
 */
export function consentDescription(op: Operation): string {
  const lines: string[] = [];

  if (op.display?.title) {
    lines.push(`**${op.display.title}**`);
  } else {
    lines.push(`**${op.type}** operation from the Company`);
  }

  lines.push(op.description);

  if (op.display?.details) {
    for (const d of op.display.details) {
      lines.push(`- ${d.label}: ${d.value}`);
    }
  }

  if (op.display?.amount) {
    lines.push(`\nAmount: ${op.display.amount}${op.display.currency ? ` ${op.display.currency}` : ""}`);
  }

  if (op.irreversible) {
    lines.push("\n⚠️ This action is **irreversible**.");
  }

  return lines.join("\n");
}

// ── Execution ─────────────────────────────────────────────────

/**
 * Sends the user's decision (approve/reject) back to the Company.
 */
export async function respondToOperation(
  op: Operation,
  decision: OperationDecision,
  session: PoppySession,
  accessToken?: string,
): Promise<OperationResult> {
  const headers = await session.headers("POST", op.endpoint, accessToken);

  const response = await fetch(op.endpoint, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      operation_id: op.id,
      decision: decision.approved ? "approved" : "rejected",
      ...(decision.reason ? { reason: decision.reason } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    return {
      success: false,
      message: `HTTP ${response.status}: ${await response.text()}`,
    };
  }

  const doc = (await response.json()) as Record<string, unknown>;
  return {
    success: doc.success !== false,
    message: typeof doc.message === "string" ? doc.message : undefined,
    data: typeof doc.data === "object" && doc.data !== null
      ? doc.data as Record<string, unknown>
      : undefined,
  };
}

/**
 * Parses an Operation from raw JSON (from a conversation event or webhook).
 */
export function parseOperation(
  raw: Record<string, unknown>,
  defaultEndpoint: string,
): Operation {
  const display = raw.display as Record<string, unknown> | undefined;
  return {
    id: String(raw.id ?? raw.operation_id ?? ""),
    type: String(raw.type ?? "unknown"),
    description: String(raw.description ?? ""),
    endpoint: typeof raw.endpoint === "string" ? raw.endpoint : defaultEndpoint,
    parameters: typeof raw.parameters === "object" && raw.parameters !== null
      ? raw.parameters as Record<string, unknown>
      : {},
    irreversible: raw.irreversible === true || raw.changes === "irreversible",
    personalData: raw.personal_data === true,
    display: display ? {
      title: typeof display.title === "string" ? display.title : undefined,
      summary: typeof display.summary === "string" ? display.summary : undefined,
      details: Array.isArray(display.details)
        ? display.details
          .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
          .map(d => ({ label: String(d.label ?? ""), value: String(d.value ?? "") }))
        : undefined,
      amount: typeof display.amount === "string" ? display.amount : undefined,
      currency: typeof display.currency === "string" ? display.currency : undefined,
    } : undefined,
    expiresAt: typeof raw.expires_at === "number" ? raw.expires_at : undefined,
  };
}
