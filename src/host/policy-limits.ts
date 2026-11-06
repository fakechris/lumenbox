/**
 * The limits a gate enforces, as configuration states them: budgets, wake rate, the approval
 * lists and the tier gate's mode. Its own module so the gate's file can stay under its ceiling;
 * `policy.ts` reads them from the environment (`defaultLimits`) and re-exports the type.
 */

import type { TierGateMode } from "./side-effects.ts";

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
  /**
   * The side-effect tier gate (INV-691): `shadow` records what it would have asked and changes
   * nothing, `enforce` asks, `off` does neither. Absent means shadow. `AGENTBOX_TIER_GATE`.
   */
  tierGate?: TierGateMode;
}
