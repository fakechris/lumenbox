/**
 * A computer tool the work needs that this run cannot have — the desktop that will not start, a
 * host runner that is off, one not on the agent's list (docs/105, INV-2196). Only these stop a
 * turn; any other refused tool already lets the agent go on, eval run or not.
 *
 * With a person there, the turn stops at the first such call and tells them what to restore
 * (INV-1797): the person can fix it, and an agent that routes around a missing capability is
 * an agent that may claim what it could not do. In an eval run (`AGENTBOX_EVAL=1`) nobody can
 * restore anything before the run ends, so stopping only waits for the benchmark's timeout.
 * There the agent is told, once and in the same words for the rest of the turn, that the tool
 * is gone: do the work another way if there is one, and if there is not, say so and stop. The
 * work is still marked as lacking the tool, so the record says what was missing.
 */

export class MissingTools {
  private readonly why = new Map<string, string>();

  /** `routeAround` is the eval run's setting: true lets the turn go on without the tool. */
  constructor(readonly routeAround: boolean) {}

  /** Whether this tool is already known missing in an eval run: the call gets the answer without being tried again. */
  known(tool: string): boolean {
    return this.routeAround && this.why.has(tool);
  }

  /** Note the tool as missing. True when the turn goes on (an eval run); false when it stops for a person. */
  note(tool: string, why: string): boolean {
    if (!this.routeAround) return false;
    if (!this.why.has(tool)) this.why.set(tool, why.trim().split("\n")[0]!.slice(0, 200));
    return true;
  }

  /** Note it and return what the model is told, or undefined when the turn stops for a person. */
  route(tool: string, why: string): string | undefined {
    return this.note(tool, why) ? this.answer(tool) : undefined;
  }

  /** What the model is told about a missing tool in an eval run. */
  answer(tool: string): string {
    return `${tool} is unavailable in this run (${this.why.get(tool) ?? "not offered here"}), and nobody can restore it before the run ends. ` +
      `Do the rest another way if there is one — WebFetch and WebSearch read the web without a desktop; bash and the file tools work on files — and deliver what was asked. ` +
      `If it cannot be done without ${tool}, say so in your reply and stop; do not say it was done.`;
  }
}
