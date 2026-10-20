/**
 * A delegated engine asks whether it may call a tool; the answer is a person's, through the
 * policy gate — the one place consent lives (docs/33, docs/81).
 *
 * Two engines ask the same question in two shapes: Claude Code through the MCP face's
 * `permission` tool, an ACP engine through `session/request_permission`. The waiting is the
 * same and is here once: check the gate; if it wants a person, wait for the approval to be
 * answered (polling, because the gate's answer is a state, not a callback); a grant makes the
 * re-check pass, a refusal shows up as a fresh approval and is withdrawn. Nobody answering in
 * time is a deny that says so, and tells the caller it was time rather than a person.
 */
import { mapEngineTool, PERMISSION_POLL_MS, PERMISSION_WAIT_MS } from "./mcp-face.ts";
import type { PolicyGate } from "./policy.ts";

export interface DelegatedConsentRequest {
  agentId: string;
  agentName: string;
  jobId?: string;
  /** The engine's own name for the tool; mapped onto the gate's where it has rules. */
  engineTool: string;
  input: Record<string, unknown>;
}

export interface DelegatedConsentOptions {
  now?: () => number;
  pollMs?: number;
  waitMs?: number;
  log?: (line: string) => void;
  /** Who the withdrawal of a refused re-check is signed by. */
  by?: string;
}

export type DelegatedConsent =
  | { allow: true }
  | { allow: false; reason: string; timedOut?: boolean; asked?: boolean };

export async function awaitDelegatedConsent(
  policy: PolicyGate | undefined,
  request: DelegatedConsentRequest,
  options: DelegatedConsentOptions = {}
): Promise<DelegatedConsent> {
  if (policy === undefined) return { allow: true };
  const tool = mapEngineTool(request.engineTool, request.input);
  const now = options.now ?? (() => Date.now());
  const ask = () =>
    policy.check({
      kind: "tool",
      agentId: request.agentId,
      agentName: request.agentName,
      tool,
      input: request.input,
      delegated: { ...(request.jobId !== undefined ? { jobId: request.jobId } : {}), ask: true },
    });
  const first = ask();
  if (first.allow) return { allow: true };
  if (first.approval === undefined) return { allow: false, reason: first.reason };
  const waitingFor = first.approval.id;
  const deadline = now() + (options.waitMs ?? PERMISSION_WAIT_MS);
  options.log?.(`${request.jobId ?? request.agentName}: waiting for a person on ${request.engineTool} (${waitingFor})`);
  while (now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? PERMISSION_POLL_MS));
    if (policy.pending().some(pending => pending.id === waitingFor)) continue;
    // Answered one way or the other: a grant makes the re-check pass and consumes it; a
    // refusal makes the re-check open a *new* request, which is the tell, and is withdrawn.
    const again = ask();
    if (again.allow) return { allow: true };
    if (again.approval !== undefined && again.approval.id !== waitingFor) {
      policy.deny(again.approval.id, options.by ?? "delegated-consent", "the person refused the delegated call");
    }
    return { allow: false, reason: "A person refused this call.", asked: true };
  }
  // Withdrawn, not left pending: the call it was about is not being made, and a question a
  // person answers later would grant nothing anyone is waiting for.
  if (policy.pending().some(pending => pending.id === waitingFor)) {
    policy.deny(waitingFor, options.by ?? "delegated-consent", "nobody answered in time; the delegated call was not made");
  }
  return { allow: false, reason: "Nobody answered the request for consent in time; the call is not made.", timedOut: true, asked: true };
}
