/**
 * The prompt and the tool schema an agent is sent (INV-1862): what a change to `prompt.ts` or to a
 * tool's description actually changes.
 *
 * Read off the first request of a real turn rather than assembled here: the stack builds the
 * system prompt and the tool list from the agent's configuration, and a second assembly of them
 * would be a second definition that drifts. So one turn is run on the episode stack with a model
 * that answers one line, and what it was sent is the surface.
 *
 * This file imports the product (`../host/`) relatively. Loaded from a checkout it gives that
 * checkout's surface; loaded from the frozen tree of another commit (frozen.ts) it gives that
 * commit's. Nothing here knows which.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { type ProviderProfile, resolveProvider } from "../host/provider.ts";
import { type EpisodeOptions, runEpisode } from "../host/scenario.ts";
import { fakeModel } from "../host/testing/fake-model.ts";
import { blankIds } from "./cache.ts";
import { canonical, digest } from "./corpus.ts";
import { say, starterSkills } from "./subjects.ts";

/**
 * Which agent, as an episode describes one. Everything is optional: the default is the agent the
 * evaluation's episodes run — one agent, the starter skills, the default provider's profile.
 */
export interface AgentConfiguration {
  /** The agents; the one whose request is read is the first by name, as the roster lists them. */
  team?: EpisodeOptions["team"];
  /** The skills the prompt lists. Default: the starter skills. */
  skills?: EpisodeOptions["skills"];
  /** A desktop index, when the browser tools are to be offered. */
  display?: number;
  provider?: ProviderProfile;
  /** A turn nobody is waiting on — a schedule's — instead of a person's: another tool list and the unattended conduct. */
  unattended?: boolean;
}

export interface PromptSurface {
  /** The system prompt as sent, its blocks joined, with the run's own agent ids blanked. */
  system: string;
  /** The tool list as sent: name, description and input schema of each. */
  tools: Anthropic.ToolUnion[];
  /**
   * The prompt on either side of the cache breakpoint (prompt.ts): what holds for the life of a conversation, and what
   * the turn rewrites — here with no memory and no tasks, so its floor. Read off the two system blocks; where the
   * provider has no breakpoints the second rides in the message instead and `volatile` is empty.
   */
  parts: { stable: string; volatile: string };
  /** UTF-8 bytes of the system prompt, of its two parts, and of the tool list as JSON. */
  bytes: { system: number; stable: number; volatile: number; tools: number };
  /** One name for the pair: two configurations with the same digest send the same prompt and tools. */
  digest: string;
}

export async function promptSurface(configuration: AgentConfiguration = {}): Promise<PromptSurface> {
  let first: Anthropic.MessageCreateParams | undefined;
  const client = fakeModel(async ({ params }) => {
    // Kept at the moment of the call: the turn goes on appending to what it sent.
    first ??= structuredClone({ system: params.system, tools: params.tools }) as Anthropic.MessageCreateParams;
    return say("A deterministic stand-in answered; no model was asked.");
  }, { streamText: true });
  const starters = starterSkills();
  const result = await runEpisode({
    team: configuration.team ?? [{ name: "Nova" }],
    says: configuration.unattended === true ? [] : ["hello"],
    ...(configuration.unattended === true ? { drive: async ({ bus, frontId }) => {
      // Sent as the orchestrator sends a routine's run, so the turn is the one a schedule starts.
      bus.sendFromUser(frontId, "[scheduled] hello", { steerable: false, lane: "background", synthetic: true }); // model-text: routine
      await bus.runExclusive(frontId, { userDriven: true });
    } } satisfies Pick<EpisodeOptions, "drive"> : {}),
    skills: configuration.skills ?? starters.skills,
    files: starters.files,
    client,
    provider: configuration.provider ?? resolveProvider("anthropic"),
    ...(configuration.display !== undefined ? { display: configuration.display } : {}),
  });
  result.cleanup();
  if (first === undefined) throw new Error("the turn made no model call, so there is no prompt to read");
  const blocks = (typeof first.system === "string" ? [first.system] : (first.system ?? []).map(block => block.text)).map(blankIds);
  const system = blocks.join("\n\n");
  const parts = { stable: blocks[0] ?? "", volatile: blocks.slice(1).join("\n\n") };
  const tools = first.tools ?? [];
  return {
    system,
    parts,
    tools,
    bytes: { system: Buffer.byteLength(system), stable: Buffer.byteLength(parts.stable), volatile: Buffer.byteLength(parts.volatile), tools: Buffer.byteLength(JSON.stringify(tools)) },
    digest: digest(canonical({ system, tools })).slice(0, 12),
  };
}
