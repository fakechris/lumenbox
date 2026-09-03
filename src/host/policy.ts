/**
 * One place that answers "may this happen?".
 *
 * Four gaps used to be four separate patches: no way to stop a running turn, no ceiling on spend, no
 * limit on how often agents wake each other, and no way to require a human's consent before
 * something irreversible. Written separately they would be four `if`s in four files, each with its
 * own idea of what a refusal looks like. Written as one decision point they are the same mechanism
 * asked four questions, and the fourth — approval — is a capability that would not otherwise exist.
 *
 * Three rules shape it, each from a failure someone else already had:
 *
 *   1. **The audit row is written before the action, not after.** "Who tried" is asked after
 *      incidents as often as "who did". A log written on success cannot answer the first.
 *   2. **State is on disk, never only in memory.** A pending approval that evaporates when the
 *      process restarts is worse than no approval: a person who clicked "allow" has no way to know
 *      their decision was lost, and the agent silently stalls forever.
 *   3. **A refusal explains itself, to the model.** A tool result saying "denied" teaches an agent
 *      nothing; one saying "denied: this tenant is over its 1,000,000-token budget for the month"
 *      lets it stop rather than retry.
 *
 * Two call sites, one decision maker. The turn loop asks about spending and about being allowed to
 * continue; tool dispatch asks about actions. Collapsing those into a single proxy in front of
 * everything was considered and rejected — this system already has the orchestrator and the box in
 * separate processes, and pretending there is one chokepoint would mean inventing one.
 *
 * **Deliberately in the box, not the control plane.** A stop has to be actionable from the UI, which
 * the box serves; spend is measured in the box; approvals are answered by a person looking at the
 * box's own screen. Putting this in the control plane would put it in the path of a turn, which the
 * architecture exists to avoid. Limits arrive as configuration; enforcement is local.
 */

import { classifyShell } from "./shell-readonly.ts";
import { envNumber } from "../config.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";

// ── what can be asked ─────────────────────────────────────────────────────────────────

export type PolicyRequest =
  /** About to call the model. Asked once per round. */
  | { kind: "model-call"; agentId: string; agentName: string; round: number; principalId?: string }
  /** About to wake a teammate. Asked before the message is delivered. */
  | { kind: "wake"; agentId: string; agentName: string; targetId: string; targetName: string }
  /** About to run a tool. Asked with the tool's real input, before anything happens. */
  | {
      kind: "tool";
      agentId: string;
      agentName: string;
      tool: string;
      input: Record<string, unknown>;
      /**
       * Set when a delegated engine, not the agent, is calling through an MCP route (docs/33).
       * Two consequences, both fail-closed: the log records the tool and the input's size and
       * never the input (the engine's arguments may carry what a tool returned last time), and
       * no standing or session approval is consulted — a call that would need a person's
       * consent is refused, because the person consented to the agent's own action, not to an
       * engine's under the agent's name.
       */
      delegated?: { jobId?: string };
    };

export type PolicyDecision =
  | { allow: true }
  /**
   * Refused. `reason` is written for the model to read: it is returned as the tool result or as the
   * turn's ending, so it has to say what would make the difference.
   */
  | { allow: false; reason: string; approval?: PendingApproval }
  ;

/** An action waiting for a person. Survives a restart, because the person's answer is worth keeping. */
export interface PendingApproval {
  id: string;
  /**
   * A hash of the exact action as it was described to the person.
   *
   * The binding is the point. An approval that names only a tool would let an agent ask to run
   * `rm README.md`, get consent, and then run `rm -rf /home/box/work` under the same grant. So the
   * grant is valid for one fingerprint, once.
   */
  fingerprint: string;
  agentId: string;
  agentName: string;
  /** Rendered for a human. This exact text is what the fingerprint covers. */
  description: string;
  requestedAt: string;
}

// ── limits ────────────────────────────────────────────────────────────────────────────

export interface PolicyLimits {
  /**
   * Tokens this box may spend in a rolling window before every model call is refused.
   *
   * Undefined means no ceiling, which is today's behaviour and is stated rather than defaulted to
   * some number that would surprise someone.
   */
  budgetTokens?: number;
  /**
   * A ceiling each person's own spend may not cross in the window — "no one channel
   * user gets more than X". Distinct from the box-wide budgetTokens, which caps
   * everyone together; a run can be under the box budget and over one person's.
   */
  perPrincipalBudgetTokens?: number;
  /**
   * A ceiling on one *agent's* own spend in the window — its allowance.
   *
   * The unit a person means by "give it a daily budget and let it decide inside that":
   * the budget belongs to the worker, not to the human who asked and not to the whole
   * box. Without it the only way to bound an agent that acts on its own — a routine it
   * wrote for itself — was to forbid it from acting on its own, which trades a large
   * capability for a small risk that was already measurable.
   */
  perAgentBudgetTokens?: number;
  /** The window the budget applies over, in hours. */
  budgetWindowHours: number;
  /** How many times one agent may wake teammates in the window below. */
  wakesPerWindow: number;
  wakeWindowMinutes: number;
  /**
   * Tools whose calls need a person's consent, by name.
   *
   * Empty by default. Turning this on for `bash` would ask about every command, which trains a
   * person to click through — so the useful configuration is narrow, and the mechanism exists
   * before the policy does.
   */
  approvalRequiredTools: readonly string[];
  /**
   * Shell commands matching any of these need consent, whatever the tool.
   *
   * Substring matches on the command line, because that is the level a person can actually review.
   * Regular expressions were considered and rejected: an operator writing one under time pressure
   * gets it subtly wrong, and a policy that fails open is worse than none.
   */
  approvalRequiredCommands: readonly string[];
}

export const DEFAULT_LIMITS: PolicyLimits = {
  budgetTokens: envLimit("AGENTBOX_BUDGET_TOKENS"),
  perPrincipalBudgetTokens: envLimit("AGENTBOX_PRINCIPAL_BUDGET_TOKENS"),
  perAgentBudgetTokens: envLimit("AGENTBOX_AGENT_BUDGET_TOKENS"),
  budgetWindowHours: envLimit("AGENTBOX_BUDGET_WINDOW_HOURS") ?? 24,
  wakesPerWindow: envLimit("AGENTBOX_WAKES_PER_WINDOW") ?? 30,
  wakeWindowMinutes: envLimit("AGENTBOX_WAKE_WINDOW_MINUTES") ?? 10,
  approvalRequiredTools: envList("AGENTBOX_APPROVAL_TOOLS"),
  approvalRequiredCommands: envList("AGENTBOX_APPROVAL_COMMANDS"),
};

/**
 * A limit, or `undefined` when nobody set one.
 *
 * Different from `envNumber` in config.ts, which answers "this tunable, or its default". Here the
 * absence is meaningful — no budget at all is a valid configuration — so the two must not share a
 * name or a shape.
 */
export function envLimit(name: string): number | undefined {
  const raw = process.env[name];
  // Unset is the only thing that means "no limit". Present-but-unreadable does not silently become
  // unlimited — an operator who set a budget and typo'd it should not end up with no budget at all.
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`[policy] ${name}="${raw}" is not a valid limit (a number >= 0); no limit applied`);
    return undefined;
  }
  // Zero is a real limit: it halts spending. It used to fall through to "no limit", so an operator
  // trying to stop the box with `=0` got the opposite.
  return value;
}

function envList(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => entry !== "");
}

// ── the record ────────────────────────────────────────────────────────────────────────

/** One line of the policy log. Append-only, replayed to derive current state. */
type PolicyEvent =
  | { at: string; kind: "checked"; request: string; agentId: string; allowed: boolean; reason?: string }
  | { at: string; kind: "stop"; agentId: string; by: string }
  | { at: string; kind: "resume"; agentId: string; by: string }
  | { at: string; kind: "approval-requested"; id: string; fingerprint: string; agentId: string; description: string }
  | { at: string; kind: "approval-granted"; id: string; by: string }
  | { at: string; kind: "approval-granted-session"; id: string; by: string }
  | {
      at: string;
      kind: "approval-granted-always";
      id: string;
      by: string;
      // Carried in full, not looked up by id: a standing grant must survive the
      // request event it answered falling off the compacted log.
      fingerprint: string;
      description: string;
      agentId: string;
    }
  | { at: string; kind: "approval-revoked"; fingerprint: string; by: string }
  | { at: string; kind: "approval-denied"; id: string; by: string; reason?: string }
  | { at: string; kind: "approval-used"; id: string };

/** A grant that outlives the moment: same agent, same exact action, until revoked. */
export interface StandingGrant {
  fingerprint: string;
  description: string;
  agentId: string;
  grantedAt: string;
  id: string;
}

/**
 * A decision, plus the one row that records what the decision set in motion.
 *
 * Separated so `check` controls the order they are written in: the decision first, then its
 * consequence.
 */
interface Outcome {
  decision: PolicyDecision;
  consequence?: PolicyEvent;
}

export interface PolicyGateOptions {
  path?: string;
  limits?: PolicyLimits;
  /**
   * Tokens spent since a moment. Injected because the usage log owns that number, and takes the
   * moment as an argument so the *window* stays defined here, next to the limit it belongs to.
   *
   * It used to be a plain `spentTokens()` over everything the usage file still held, which made
   * `budgetWindowHours` decorative: it appeared in the refusal text and nowhere else. A box that
   * exhausted a "24-hour" budget on Monday stayed refused on Tuesday, until enough unrelated
   * records happened to push the old ones out of the file.
   */
  spentSince?: (sinceMs: number) => number;
  /** Spend since a moment for one person, for the per-principal cap. */
  spentSincePrincipal?: (sinceMs: number, principalId: string) => number;
  /** Spend since a moment for one agent, for its own allowance. */
  spentSinceAgent?: (sinceMs: number, agentId: string) => number;
  /**
   * Why spend cannot be measured right now, when it cannot.
   *
   * Separate from `spentSince` because "unknown" is not a number, and the two used to share one:
   * an unreadable or unwritable usage log reported zero spent, so a configured ceiling stopped
   * applying at exactly the moment its accounting broke.
   */
  spendUnavailable?: () => string | undefined;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * Reads and writes the policy record, and answers questions against it.
 *
 * The file is append-only and replayed on construction, which is the same shape as the transcript
 * and the activity feed. Replay rather than a mutable snapshot because the interesting states —
 * "approved but not yet used", "stopped and not resumed" — are transitions, and a snapshot loses the
 * order they happened in.
 */
export class PolicyGate {
  private readonly path: string;
  private readonly limits: PolicyLimits;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly spentSince: (sinceMs: number) => number;
  private readonly spentSincePrincipal: (sinceMs: number, principalId: string) => number;
  private readonly spentSinceAgent: (sinceMs: number, agentId: string) => number;
  private readonly spendUnavailable: () => string | undefined;

  /**
   * Called the moment a new approval is created, with what a notifier needs.
   *
   * A public assignable field rather than a constructor option because the one caller
   * that wants it (the web server) meets the gate long after construction. Polling
   * still works without it; this is what lets a desktop shell say "an agent is
   * waiting on you" while the window is closed.
   */
  onApprovalRequested: ((approval: PendingApproval) => void) | undefined;

  /** Agents whose current turn a person has asked to stop. */
  private readonly stopped = new Set<string>();
  /** Approvals granted and not yet consumed, by fingerprint. */
  private readonly granted = new Map<string, PendingApproval>();
  /** Approvals asked for and not yet answered, by fingerprint. */
  private readonly awaiting = new Map<string, PendingApproval>();
  /**
   * Grants that hold until this process ends, by fingerprint. In memory on purpose
   * and deliberately not rebuilt by replay: "for this session" means exactly the
   * lifetime of the process the person said it to.
   */
  private readonly session = new Map<string, PendingApproval>();
  /** Grants that hold until revoked, by fingerprint. Replayed from the log. */
  private readonly always = new Map<string, StandingGrant>();
  /** Wake timestamps per agent, for the rate limit. Rebuilt from the log on start. */
  private readonly wakes = new Map<string, number[]>();

  constructor(options: PolicyGateOptions = {}) {
    this.path = options.path ?? join(agentboxHome(), "policy.jsonl");
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.spentSince = options.spentSince ?? (() => 0);
    this.spendUnavailable = options.spendUnavailable ?? (() => undefined);
    this.spentSincePrincipal = options.spentSincePrincipal ?? (() => 0);
    this.spentSinceAgent = options.spentSinceAgent ?? (() => 0);
    this.replay();
  }

  // ── the question ────────────────────────────────────────────────────────────────────

  /**
   * Decides, and records the decision before the caller acts on it.
   *
   * Every path through here writes exactly one `checked` row first. That ordering is the whole
   * reason this is a method and not four scattered conditions.
   */
  check(request: PolicyRequest): PolicyDecision {
    const { decision, consequence } = this.decide(request);
    this.append({
      at: this.now().toISOString(),
      kind: "checked",
      request: describeRequest(request),
      agentId: request.agentId,
      allowed: decision.allow,
      ...(decision.allow ? {} : { reason: decision.reason }),
    });
    // After the decision row, not before it: the log should read as the story it is — we checked, we
    // refused, so we asked a person. Both are written before this returns, so nothing acts on a
    // decision that is not yet on the record.
    if (consequence !== undefined) {
      const written = this.append(consequence);
      // One consequence cannot be allowed to go unrecorded: consuming a person's approval. The
      // grant has already been removed from memory, so if the row saying so does not reach the log,
      // a replay after a restart finds it granted-and-unused and permits the identical destructive
      // action a second time without asking anyone. Everything else here stands unlogged, because a
      // turn dying over bookkeeping is worse; consent that cannot be recorded is the exception.
      if (!written && consequence.kind === "approval-used") {
        const reason =
          `This was approved, but the approval could not be recorded, so it has not been used. ` +
          `Acting on consent that is not on the record would let the same action be approved once ` +
          `and run twice. Ask again once the policy log is writable.`;
        this.log(`refused ${describeRequest(request)}: the approval could not be recorded`);
        return { allow: false, reason };
      }
    }
    if (!decision.allow) {
      this.log(`refused ${describeRequest(request)}: ${decision.reason}`);
    }
    return decision;
  }

  private decide(request: PolicyRequest): Outcome {
    // Checked first for every kind: a person who pressed stop meant all of it, not just the model
    // call that happened to come next.
    if (this.stopped.has(request.agentId)) {
      return {
        decision: {
          allow: false,
          reason:
            "A person stopped this turn. Do not continue, retry, or start related work; " +
            "report where you got to and end the turn.",
        },
      };
    }

    if (request.kind === "model-call")
      return { decision: this.decideSpend(request.principalId, request.agentId) };
    if (request.kind === "wake") return { decision: this.decideWake(request.agentId) };
    return this.decideTool(request);
  }

  private decideSpend(principalId?: string, agentId?: string): PolicyDecision {
    // The agent's own allowance, checked first: it is the tightest of the three and the
    // one an agent can reason about. The refusal names the number so it stops rather than
    // retrying — and so a person reading the transcript can see it chose to stop.
    const perAgent = this.limits.perAgentBudgetTokens;
    if (perAgent !== undefined && agentId !== undefined) {
      const windowMs = Math.max(0, this.limits.budgetWindowHours) * 3_600_000;
      const mine = this.spentSinceAgent(this.now().getTime() - windowMs, agentId);
      if (mine >= perAgent) {
        return {
          allow: false,
          reason:
            `You have spent ${mine} tokens in the last ${this.limits.budgetWindowHours}h, at or ` +
            `over your ${perAgent}-token allowance. Nothing further will run for you until the ` +
            `window rolls over or someone raises it. Stop here and say so — including stopping ` +
            `any routine of your own that is asking for this.`,
        };
      }
    }
    const perPerson = this.limits.perPrincipalBudgetTokens;
    if (perPerson !== undefined && principalId !== undefined) {
      const windowMs = Math.max(0, this.limits.budgetWindowHours) * 3_600_000;
      const theirs = this.spentSincePrincipal(this.now().getTime() - windowMs, principalId);
      if (theirs >= perPerson) {
        return {
          allow: false,
          reason:
            `This person has spent ${theirs} tokens in the last ${this.limits.budgetWindowHours}h, ` +
            `at or over their ${perPerson}-token cap. No further model calls will be made on their ` +
            `behalf until the window rolls over or the cap is raised. Stop here and say so.`,
        };
      }
    }
    const budget = this.limits.budgetTokens;
    // No ceiling means nothing depends on the number, so a broken accounting file is not this
    // function's problem and refusing over it would be gratuitous.
    if (budget === undefined) return { allow: true };

    const unavailable = this.spendUnavailable();
    if (unavailable !== undefined) {
      return {
        allow: false,
        reason:
          `This box has a ${budget}-token budget and its spending cannot be measured: ` +
          `${unavailable}. Refusing rather than assuming nothing has been spent — that assumption ` +
          `is exactly how a ceiling stops applying at the moment its accounting breaks. Stop here ` +
          `and say so.`,
      };
    }
    const windowMs = Math.max(0, this.limits.budgetWindowHours) * 3_600_000;
    const spent = this.spentSince(this.now().getTime() - windowMs);
    if (spent < budget) return { allow: true };
    return {
      allow: false,
      reason:
        `This box has spent ${spent} tokens in the last ${this.limits.budgetWindowHours}h, ` +
        `which is at or over its ${budget} budget. No further model calls will be made until the ` +
        `window rolls over or the budget is raised. Stop here and say so.`,
    };
  }

  private decideWake(agentId: string): PolicyDecision {
    const windowMs = this.limits.wakeWindowMinutes * 60_000;
    const cutoff = this.now().getTime() - windowMs;
    const recent = (this.wakes.get(agentId) ?? []).filter(at => at > cutoff);
    this.wakes.set(agentId, recent);
    if (recent.length < this.limits.wakesPerWindow) {
      recent.push(this.now().getTime());
      return { allow: true };
    }
    // The failure this prevents: two agents that wake each other, each turn generating the next.
    // Nothing else in the system stops that, and it spends money at the speed of the API.
    return {
      allow: false,
      reason:
        `You have woken teammates ${recent.length} times in ${this.limits.wakeWindowMinutes} ` +
        `minutes, which is the limit. Two agents taking turns to wake each other is a loop that ` +
        `spends money without progressing. Finish what you are doing and reply to the person ` +
        `instead of delegating again.`,
    };
  }

  private decideTool(request: Extract<PolicyRequest, { kind: "tool" }>): Outcome {
    if (!this.needsApproval(request)) return { decision: { allow: true } };
    if (request.delegated !== undefined) {
      return {
        decision: {
          allow: false,
          reason:
            `${request.tool} would need a person's approval, and a delegated engine cannot ask for one ` +
            `— nor use an approval given to ${request.agentName} for its own actions. Leave this ` +
            `call to the agent that delegated you, and say so in your result.`,
        },
      };
    }

    const description = describeRequest(request);
    // Refused outright, not truncated: see `tooLargeToApprove`.
    const tooLarge = tooLargeToApprove(description);
    if (tooLarge !== undefined) return { decision: { allow: false, reason: tooLarge } };

    const fingerprint = fingerprintOf(request.agentId, description);

    // A standing or session grant covers this exact action without being consumed.
    // Each use still writes an approval-used row, so the audit trail says every time
    // the grant did work, not only the day it was given.
    const standing = this.always.get(fingerprint);
    if (standing !== undefined) {
      return {
        decision: { allow: true },
        consequence: { at: this.now().toISOString(), kind: "approval-used", id: standing.id },
      };
    }
    const sessionGrant = this.session.get(fingerprint);
    if (sessionGrant !== undefined) {
      return {
        decision: { allow: true },
        consequence: { at: this.now().toISOString(), kind: "approval-used", id: sessionGrant.id },
      };
    }

    // Granted earlier and not yet used. Consumed here, so the same grant cannot cover a second run.
    const grant = this.granted.get(fingerprint);
    if (grant !== undefined) {
      this.granted.delete(fingerprint);
      return {
        decision: { allow: true },
        consequence: { at: this.now().toISOString(), kind: "approval-used", id: grant.id },
      };
    }

    const existing = this.awaiting.get(fingerprint);
    if (existing !== undefined) {
      return {
        decision: {
          allow: false,
          reason: approvalReason(existing.description),
          approval: existing,
        },
      };
    }

    const approval: PendingApproval = {
      id: randomUUID(),
      fingerprint,
      agentId: request.agentId,
      agentName: request.agentName,
      description,
      requestedAt: this.now().toISOString(),
    };
    this.awaiting.set(fingerprint, approval);
    this.log(`waiting for a person to approve: ${description}`);
    try {
      this.onApprovalRequested?.(approval);
    } catch {
      // A notifier's failure must not change a policy decision.
    }
    return {
      decision: { allow: false, reason: approvalReason(description), approval },
      consequence: {
        at: approval.requestedAt,
        kind: "approval-requested",
        id: approval.id,
        fingerprint,
        agentId: approval.agentId,
        description,
      },
    };
  }

  private needsApproval(request: Extract<PolicyRequest, { kind: "tool" }>): boolean {
    // Host execution always asks, by construction rather than by configuration: it is
    // the one tool that runs outside the box, and an operator turning it off is done
    // by not enabling it at all, not by trusting an empty approval list.
    if (request.tool === "RunOnHost") return true;
    if (this.limits.approvalRequiredTools.includes(request.tool)) return true;
    const command = typeof request.input.command === "string" ? request.input.command : "";
    if (command === "") return false;
    return this.limits.approvalRequiredCommands.some(needle => command.includes(needle));
  }

  // ── what a person does ──────────────────────────────────────────────────────────────

  /** Stops an agent's current turn. Idempotent, so a second click is not an error. */
  stop(agentId: string, by = "user"): void {
    if (this.stopped.has(agentId)) return;
    this.stopped.add(agentId);
    this.append({ at: this.now().toISOString(), kind: "stop", agentId, by });
    this.log(`${by} stopped ${agentId}`);
  }

  /**
   * Clears a stop.
   *
   * Called when the next turn starts, not by a person: a stop applies to the turn that was running,
   * and leaving it set would silently refuse the person's *next* instruction — which reads as the
   * agent having broken rather than having been stopped.
   */
  resume(agentId: string, by = "system"): void {
    if (!this.stopped.has(agentId)) return;
    this.stopped.delete(agentId);
    this.append({ at: this.now().toISOString(), kind: "resume", agentId, by });
  }

  isStopped(agentId: string): boolean {
    return this.stopped.has(agentId);
  }

  /** Everything waiting on a person, newest last. */
  pending(): PendingApproval[] {
    return [...this.awaiting.values()].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  /**
   * Grants one approval by id, at one of three scopes.
   *
   * "once" is consumed by its first use — the default, and the safest. "session"
   * holds for this process's lifetime and dies with it. "always" holds until revoked
   * and survives restarts. All three cover the *exact* action text the person read;
   * none of them widens to a class of actions, because the fingerprint is the grant.
   *
   * Returns false for an unknown or already-answered id rather than throwing: the usual cause is a
   * second click or a stale page, and neither deserves an error.
   */
  grant(id: string, by = "user", scope: "once" | "session" | "always" = "once"): boolean {
    const found = [...this.awaiting.values()].find(approval => approval.id === id);
    if (found === undefined) return false;
    this.awaiting.delete(found.fingerprint);
    const at = this.now().toISOString();

    if (scope === "always") {
      this.always.set(found.fingerprint, {
        fingerprint: found.fingerprint,
        description: found.description,
        agentId: found.agentId,
        grantedAt: at,
        id,
      });
      this.append({
        at,
        kind: "approval-granted-always",
        id,
        by,
        fingerprint: found.fingerprint,
        description: found.description,
        agentId: found.agentId,
      });
      this.log(`${by} approved, standing until revoked: ${found.description}`);
      return true;
    }

    if (scope === "session") {
      this.session.set(found.fingerprint, found);
      this.append({ at, kind: "approval-granted-session", id, by });
      this.log(`${by} approved for this session: ${found.description}`);
      return true;
    }

    this.granted.set(found.fingerprint, found);
    this.append({ at, kind: "approval-granted", id, by });
    this.log(`${by} approved: ${found.description}`);
    return true;
  }

  /** The standing grants, for showing a person what holds and letting them end it. */
  standingGrants(): StandingGrant[] {
    return [...this.always.values()].sort((a, b) => a.grantedAt.localeCompare(b.grantedAt));
  }

  /** Ends a standing grant. The next identical action asks again. */
  revokeStanding(fingerprint: string, by = "user"): boolean {
    if (!this.always.has(fingerprint)) return false;
    this.always.delete(fingerprint);
    this.append({ at: this.now().toISOString(), kind: "approval-revoked", fingerprint, by });
    this.log(`${by} revoked a standing approval`);
    return true;
  }

  deny(id: string, by = "user", reason?: string): boolean {
    const found = [...this.awaiting.values()].find(approval => approval.id === id);
    if (found === undefined) return false;
    this.awaiting.delete(found.fingerprint);
    this.append({ at: this.now().toISOString(), kind: "approval-denied", id, by, ...(reason ? { reason } : {}) });
    return true;
  }

  // ── the file ────────────────────────────────────────────────────────────────────────

  private append(event: PolicyEvent): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
      return true;
    } catch (error) {
      // A policy decision must not fail because its log could not be written — the alternative is a
      // turn that dies over bookkeeping. But it is said loudly, because an unrecorded refusal is
      // exactly what an audit is for.
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`policy: cannot write ${this.path} (${detail}); the decision stands but is unlogged`);
      return false;
    }
  }

  /**
   * Rebuilds current state from the log.
   *
   * The ordering matters and is why this is a replay rather than a snapshot read: an approval that
   * was requested, granted and used is not pending, and only the sequence says so.
   */
  private replay(): void {
    if (!existsSync(this.path)) return;
    let lines: string[];
    try {
      lines = readFileSync(this.path, "utf8").split("\n").filter(line => line.trim() !== "");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`policy: cannot read ${this.path} (${detail}); starting with no remembered state`);
      return;
    }

    const byId = new Map<string, PendingApproval>();
    for (const line of lines) {
      let event: PolicyEvent;
      try {
        event = JSON.parse(line) as PolicyEvent;
      } catch {
        continue; // A torn last line costs one event, not the file.
      }
      switch (event.kind) {
        case "stop":
          this.stopped.add(event.agentId);
          break;
        case "resume":
          this.stopped.delete(event.agentId);
          break;
        case "approval-requested": {
          const approval: PendingApproval = {
            id: event.id,
            fingerprint: event.fingerprint,
            agentId: event.agentId,
            agentName: "",
            description: event.description,
            requestedAt: event.at,
          };
          byId.set(event.id, approval);
          this.awaiting.set(event.fingerprint, approval);
          break;
        }
        case "approval-granted": {
          const approval = byId.get(event.id);
          if (approval === undefined) break;
          this.awaiting.delete(approval.fingerprint);
          this.granted.set(approval.fingerprint, approval);
          break;
        }
        case "approval-granted-session": {
          // The question was answered, so it is no longer pending — but the grant
          // itself belonged to a process that has ended, so it is not rebuilt.
          const approval = byId.get(event.id);
          if (approval !== undefined) this.awaiting.delete(approval.fingerprint);
          break;
        }
        case "approval-granted-always":
          this.awaiting.delete(event.fingerprint);
          this.always.set(event.fingerprint, {
            fingerprint: event.fingerprint,
            description: event.description,
            agentId: event.agentId,
            grantedAt: event.at,
            id: event.id,
          });
          break;
        case "approval-revoked":
          this.always.delete(event.fingerprint);
          break;
        case "approval-denied":
        case "approval-used": {
          const approval = byId.get(event.id);
          if (approval === undefined) break;
          this.awaiting.delete(approval.fingerprint);
          this.granted.delete(approval.fingerprint);
          break;
        }
        default:
          break;
      }
    }

    if (this.stopped.size > 0 || this.awaiting.size > 0) {
      this.log(
        `policy: resumed with ${this.awaiting.size} approval(s) waiting and ` +
          `${this.stopped.size} agent(s) stopped`
      );
    }
    if (lines.length > COMPACT_AT) this.compact(lines);
  }

  /** Rewrites the log with what still matters, so it does not grow without bound. */
  private compact(lines: readonly string[]): void {
    try {
      // Standing grants are re-stated ahead of the tail: a grant given months ago is
      // still in force, and a compaction that keeps only recent events must not
      // silently turn "always" back into "ask me every time".
      const standing = this.standingGrants().map(grant =>
        JSON.stringify({
          at: grant.grantedAt,
          kind: "approval-granted-always",
          id: grant.id,
          by: "compaction",
          fingerprint: grant.fingerprint,
          description: grant.description,
          agentId: grant.agentId,
        } satisfies PolicyEvent)
      );
      const kept = [...standing, ...lines.slice(-KEEP_ON_COMPACT)];
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, `${kept.join("\n")}\n`, "utf8");
      renameSync(temp, this.path);
      this.log(`policy: compacted the log to its last ${kept.length} events`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`policy: cannot compact ${this.path} (${detail})`);
    }
  }
}

const COMPACT_AT = envNumber("AGENTBOX_POLICY_COMPACT_AT", 20_000);
const KEEP_ON_COMPACT = envNumber("AGENTBOX_POLICY_KEEP", 5_000);

// ── describing and binding ────────────────────────────────────────────────────────────

/**
 * The one rendering of an action, used for the person, the log, and the fingerprint.
 *
 * One function on purpose. If the text shown to a person and the text that was hashed could differ,
 * the binding would be decorative — someone could be shown one command and consent to another.
 */
export function describeRequest(request: PolicyRequest): string {
  switch (request.kind) {
    case "model-call":
      return `${request.agentName}: model call (round ${request.round})`;
    case "wake":
      return `${request.agentName}: wake ${request.targetName}`;
    case "tool": {
      if (request.delegated !== undefined) {
        const bytes = Buffer.byteLength(JSON.stringify(request.input));
        return `${request.agentName}: ${request.tool} via delegated job ${request.delegated.jobId ?? "(starting)"} (${bytes} bytes of input, not recorded)`;
      }
      const command = typeof request.input.command === "string" ? request.input.command : undefined;
      const detail = command ?? JSON.stringify(request.input);
      // Said on the card when it is certain, so a person approving `git status && ls` is told the
      // one thing that decides it. Silence otherwise: "not known to be read-only" is not a warning.
      const readOnly =
        command !== undefined && (request.tool === "RunOnHost" || request.tool === "bash") && classifyShell(command).readOnly
          ? " [read-only]"
          : "";
      return `${request.agentName}: ${request.tool} — ${detail}${readOnly}`;
    }
  }
}

/**
 * The most an action may be and still be approvable.
 *
 * Generous — far beyond any real command or path — because the number is not the point. The point is
 * that consent is given to *what the person read*, so an action too large to show has to be refused
 * rather than shortened.
 */
export const MAX_APPROVABLE_DESCRIPTION = 2_000;

/**
 * Why an action cannot be put in front of a person at all, if it cannot.
 *
 * This closes a hole in the first version of this file. `describeRequest` truncated at 400
 * characters, and the fingerprint was taken over the truncated text — so two commands sharing their
 * first 400 characters and differing after would pass under one grant. Truncating what a person is
 * shown while binding a grant to it makes the binding decorative.
 */
export function tooLargeToApprove(description: string): string | undefined {
  if (description.length <= MAX_APPROVABLE_DESCRIPTION) return undefined;
  return (
    `This action is ${description.length} characters long, and cannot be shown to a person in full ` +
    `(the limit is ${MAX_APPROVABLE_DESCRIPTION}). It is refused rather than shortened, because ` +
    `approving a summary of an action is not approving the action. Break it into smaller steps, or ` +
    `put the payload in a file and act on the file.`
  );
}

/** Binds a grant to one agent and one exact description. */
export function fingerprintOf(agentId: string, description: string): string {
  return createHash("sha256").update(`${agentId} ${description}`).digest("hex").slice(0, 32);
}

function approvalReason(description: string): string {
  return (
    `This needs a person's approval before it can run: ${description}\n` +
    `It has been put in front of them. Do not try to work around it, and do not repeat the ` +
    `request — ask the person directly if it is urgent, or continue with something else.`
  );
}
