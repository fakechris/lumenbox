/**
 * The names an agent-written skill may not carry.
 *
 * A skill is a method the agents reuse; the ledgers below are how the host judges them.
 * A "skill" that names the task board file, the fork ledger or the policy log is, whatever
 * it says it is for, a way to write the verdict instead of earning it — Argus quarantines
 * skill candidates that name its verifier surface for exactly this reason, and its incident
 * notes are why. Refused at the write, and skipped at load when one arrived another way,
 * with the offending name said so the refusal can be argued with.
 */

const CONTROL_SURFACES: readonly RegExp[] = [
  /\btasks\.jsonl\b/,
  /\bpending-work\.jsonl\b/,
  /\bpolicy\.jsonl\b/,
  /\bturns\.jsonl\b/,
  /\bingress\.jsonl\b/,
  /\bdeliveries\.jsonl\b/,
  /\busage\.jsonl\b/,
  /\bauto-review\.jsonl\b/,
  /\bdelegate-calls\.jsonl\b/,
  /\bschedules\.jsonl\b/,
  /\bclaims\.jsonl\b/,
  /(?:^|[\s"'`(])~?\/?(?:home\/hostd\/)?\.agentbox(?:\/|\b)/,
  /\bLUMENBOX_MCP_TOKEN\b/,
  /\bLUMENBOX_RELAY_TOKEN\b/,
];

/** The first control surface a text names, or undefined when it names none. */
export function namesControlSurface(text: string): string | undefined {
  for (const pattern of CONTROL_SURFACES) {
    const match = pattern.exec(text);
    if (match !== null) return match[0].trim();
  }
  return undefined;
}
