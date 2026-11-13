/**
 * Host prompts that were written before the `host` stamp existed, recognised by their opening
 * words so a record nobody rewrites still reads right. Each is the exact text the host writes
 * (`progress.ts` continuationPrompt, `turn.ts` last round and Stop hook, and the rest below), so a person who
 * happens to type these words is not mistaken for the host.
 */
export const LEGACY_HOST_PROMPTS: readonly RegExp[] = [
  /^You have used \d+ tool rounds, which is the limit for one turn/,
  /^\[last round\] You have one response left in this turn/,
  /^\[Stop hook\] /,
  // The audit request (audit.ts), which was queued as a person's message until 2026-11-04.
  /^Audit task t\d+: ".*", which .+ claims is done\./,
  // The job notice (job-watch.ts) and the note about a message that arrived mid-answer (turn.ts).
  /^\[A command you started earlier [^\]\n]+: job-[\w-]+\]/,
  /^\[\d+ commands you started earlier ended within a few seconds of each other; all of them follow\.\]/,
  /^\[newer message\] /,
];
