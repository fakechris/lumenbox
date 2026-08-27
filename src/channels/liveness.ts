/**
 * Whether an inbound channel is still there.
 *
 * A channel said "connected" once and never spoke again. Ninety minutes later its
 * WebSocket was gone — `lsof` showed zero established connections — and nothing had
 * logged a disconnect, a retry, or a failure to retry. Messages sent to the bot reached
 * nobody, the ingress ledger correctly recorded that nothing had arrived, and *that reads
 * exactly like a quiet afternoon*.
 *
 * Which is the gap. The ingress ledger answers "did this message arrive"; nothing
 * answered "is anyone listening". The two are indistinguishable from the outside and have
 * opposite remedies — wait, versus reconnect.
 *
 * **Proved rather than asked.** The SDK offers no connection state and no close hook, so
 * asking it is asking the thing that already failed to notice. A probe that reaches the
 * vendor's API on its own is evidence from outside the component under test; combined
 * with how long the channel has been silent, it separates the two cases:
 *
 *   - probe fails → the credentials or the network are the problem, and say which
 *   - probe succeeds, nothing has arrived for hours → the socket is dead behind a healthy
 *     account, which is exactly the case that produced no signal at all
 *   - probe succeeds, something arrived recently → nothing to report
 *
 * Nothing here reconnects. It reports, and reporting is the part that was missing; a
 * reconnect that also happens silently would rebuild the same blindness one layer up.
 */

/** How long a channel may hear nothing before silence is worth checking. */
export const SILENCE_BEFORE_SUSPECT_MS = 2 * 3_600_000;

export type ChannelHealth =
  /** Reachable, and either recently busy or not yet suspiciously quiet. */
  | { state: "ok"; detail: string }
  /** Reachable as an account, but silent long enough that the socket is in doubt. */
  | { state: "suspect"; detail: string }
  /** Not reachable at all — credentials, network, or the vendor. */
  | { state: "unreachable"; detail: string };

export interface LivenessInput {
  channel: string;
  /** When this channel last had anything from outside, or undefined for never. */
  lastInboundAt: string | undefined;
  now: number;
  /** Reaches the vendor independently of the socket. Resolves with why, or undefined when fine. */
  probe: () => Promise<string | undefined>;
  silenceMs?: number;
}

export async function channelHealth(input: LivenessInput): Promise<ChannelHealth> {
  const failure = await input.probe().catch((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  );
  if (failure !== undefined) {
    return {
      state: "unreachable",
      detail:
        `${input.channel} cannot be reached (${failure}). Nothing sent to the bot is ` +
        `arriving, and this is not a quiet period.`,
    };
  }

  const silenceMs = input.silenceMs ?? SILENCE_BEFORE_SUSPECT_MS;
  const last = input.lastInboundAt === undefined ? undefined : Date.parse(input.lastInboundAt);
  const quietFor =
    last === undefined || Number.isNaN(last) ? undefined : input.now - last;

  // Never having heard anything is the ordinary state of a fresh installation, and is not
  // evidence of a dead socket. Only a channel that *used* to work and stopped is.
  if (quietFor === undefined) return { state: "ok", detail: `${input.channel}: nothing yet` };
  if (quietFor < silenceMs) {
    return { state: "ok", detail: `${input.channel}: last heard ${describeAge(quietFor)} ago` };
  }
  return {
    state: "suspect",
    detail:
      `${input.channel} has heard nothing for ${describeAge(quietFor)} while its account ` +
      `answers normally. Either it is genuinely quiet or its connection is gone and said ` +
      `nothing — restart to rule out the second.`,
  };
}

function describeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
