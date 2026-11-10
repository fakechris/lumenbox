import type { Outcome } from "../protocol/index.ts";
import type { CommitHow } from "./pending-work.ts";
import type { ToolEffect } from "./mcp.ts";

export interface ToolOutcome {
  text: string;
  /** Structured execution outcome, separate from business verification. */
  outcome?: Outcome;
  /**
   * Fork ledger ids to commit once this result is durably in the parent's transcript
   * (docs/32 §1). Written by the turn engine after the results entry is appended — the tool
   * cannot know that moment, and committing before it is the review's finding #5.
   */
  commit?: { id: string; how: CommitHow }[];
  /** base64 image payloads to attach to the tool result. */
  images?: { mediaType: "image/webp" | "image/png" | "image/jpeg" | "image/gif"; data: string }[];
  isError?: boolean;
  /**
   * What the transcript stores instead of `text`, when the two must differ.
   *
   * The model sees `text`; the durable record sees this. Exactly one tool uses it, and
   * the reason is the only reason worth having: `RunOnHost` is told which vault secrets a
   * command was given, so for those calls the harness *knows* the output may contain a
   * credential — no pattern, no guess, no model judgement (docs/15). Every other approach
   * to keeping secrets out of the record is a suspicion applied everywhere; this is
   * certainty applied in one place.
   *
   * It is not containment from the model, which nothing achieves: the model read the
   * output and can restate it. It is containment from the *record*, which is what R7 is
   * about.
   */
  recordAs?: string;
  /**
   * The approval this call is waiting on, when the policy gate put it in front of a person
   * instead of running it (INV-774). The step ledger records it, so a restart parks the
   * turn on the person's answer rather than answering the call `outcome_unknown`.
   */
  approval?: { id: string };
  /**
   * What the result asked the harness to do (INV-861), and which prefixed tool asked — the
   * turn applies them through effects.ts after the call, never inside a fork.
   */
  effects?: ToolEffect[];
  effectsFrom?: string;
}

