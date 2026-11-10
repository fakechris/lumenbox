/** Events sent to task observers and the live conversation. Optional identity reads older producers. */
export type TurnEvent = TurnEventBody & { conversation?: string; turnId?: string };

export type TurnEventBody =
  | { type: "text"; agentId: string; agentName: string; delta: string }
  /**
   * The model's opening line on a person-opened turn, said alongside its first tool calls
   * (docs/31 layer 1a). Delivered to the chat at once so the person sees the acknowledgement
   * while the tools run; not part of the final reply, which `replySince` still assembles
   * from plain entries only. Once per turn.
   */
  | { type: "interim"; agentId: string; agentName: string; text: string }
  /** A delegated engine called one of the host's MCP tools through its route (docs/33). */
  | { type: "delegate_call"; agentId: string; agentName: string; tool: string; ok: boolean; ms: number }
  | { type: "tool_start"; agentId: string; agentName: string; tool: string; input: unknown; toolUseId?: string }
  | {
      type: "tool_end";
      agentId: string;
      agentName: string;
      tool: string;
      summary: string;
      toolUseId?: string;
      isError?: boolean;
      /**
       * base64 WebP, when the tool returned one. Carried so a watching UI can
       * show what the agent actually saw, which is the difference between
       * trusting its account of the screen and checking it.
       */
      screenshot?: string; gate?: import("./gate-verdict.ts").GateVerdict; // and the policy gate's verdict on this step and why, when it checked one (INV-1664)
    }
  | { type: "round"; agentId: string; round: number }
  /**
   * The history outgrew the context window and was summarised.
   *
   * Its own event rather than a line of agent prose: the agent did not say this, and a feed that
   * attributes it to the agent is lying about who is talking. It is feed-worthy because it is the
   * one moment where what the agent can see stops matching what it did.
   */
  | {
      type: "compacted";
      agentId: string;
      /** How many entries the summary stands in for. */
      covers: number;
      /** False when summarising failed and the entries were dropped instead. */
      summarised: boolean;
      tokensBefore?: number;
      tokensAfter?: number;
      detail: string;
    }
  | { type: "aborted"; agentId: string }
  /**
   * The turn stopped because it was going in circles, not because it finished.
   *
   * Its own event because the *turn* ending here is an outcome rather than a failure —
   * the agent was told why it stopped, and the report is in its transcript — while for
   * anyone watching from outside it is neither done nor broken but *waiting for a
   * person*. A surface that cannot tell those apart shows a green tick over abandoned
   * work, which is the one thing a board must never do.
   */
  | { type: "stuck"; agentId: string; reason: string }
  /** The turn ended on its own call budget (INV-1354): handed back to the person, not failed. */
  | { type: "turn_budget_hit"; agentId: string; calls: number; limit: number }
  /**
   * A round failed in a way a retry can fix, and is being retried.
   *
   * `discardPartial` is the load-bearing field: nothing was written to the transcript, so a partial
   * answer exists only on the watcher's screen and would otherwise appear twice.
   */
  | {
      type: "retrying";
      agentId: string;
      round: number;
      attempt: number;
      delayMs: number;
      kind: string;
      discardPartial: boolean;
      detail: string;
    }
  | {
      type: "usage";
      /** Which round of the turn, so a long turn is visible as one. */
      round: number;
      agentId: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      metering?: import("./usage.ts").UsageMetering;
    };

