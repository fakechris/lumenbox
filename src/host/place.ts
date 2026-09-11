/**
 * Instructions that belong to a place, not to a worker (INV-428, docs/50 I2).
 *
 * Claude Tag concatenates custom instructions org → workspace → channel into the system
 * prompt. Ours: the installation's `~/.agentbox/instructions.md`, then every bundle the
 * agent's box carries (`Bundle.instructions`), then the agent's own persona, which is
 * already the `profile` section. The more specific place reads later, so it is what the
 * model has most recently read when it meets the conversation.
 *
 * Text, not rules: what goes here is house style, data classification, "we say 客户 not
 * 用户" — the things an organisation says once to everyone. It is untrusted the way the
 * persona is: an operator wrote it, and an operator can already write the persona.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../config.ts";

/** How much of a place's instructions goes into every prompt. Beyond this, it is a document. */
export const MAX_PLACE_INSTRUCTIONS_CHARS = 6_000;

export interface PlaceInstructions {
  /** From `~/.agentbox/instructions.md`. */
  installation?: string;
  /** The box's name, for the heading. */
  boxName?: string;
  /** From the bundles the box carries, in attachment order. */
  box: string[];
}

export function installationInstructionsPath(): string {
  return process.env.AGENTBOX_INSTRUCTIONS ?? join(agentboxHome(), "instructions.md");
}

/**
 * The installation's instructions, or undefined when there are none.
 *
 * Never throws: a missing file is the common case, and under test `agentboxHome` refuses
 * its default — both mean "nothing to say", not "cannot build a prompt".
 */
export function readInstallationInstructions(path?: string): string | undefined {
  try {
    const at = path ?? installationInstructionsPath();
    if (!existsSync(at)) return undefined;
    const text = readFileSync(at, "utf8").trim();
    return text === "" ? undefined : clip(text);
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  return text.length <= MAX_PLACE_INSTRUCTIONS_CHARS
    ? text
    : `${text.slice(0, MAX_PLACE_INSTRUCTIONS_CHARS)}\n\n(cut here — the rest is too long for a prompt; keep it in a document the agent can read)`;
}

/** The prompt section, or empty when no place has anything to say. */
export function renderPlace(place: PlaceInstructions | undefined): string {
  if (place === undefined) return "";
  const parts: string[] = [];
  if (place.installation !== undefined) {
    parts.push(`From this installation:\n\n${place.installation}`);
  }
  const box = place.box.map(text => text.trim()).filter(text => text !== "");
  if (box.length > 0) {
    const where = place.boxName !== undefined ? `From the ${place.boxName} box` : "From your box";
    parts.push(`${where}:\n\n${clip(box.join("\n\n"))}`);
  }
  if (parts.length === 0) return "";
  return `# House rules\n\nWhat the people who run this place have asked of every agent here. The later a rule is\nlisted, the closer it is to where you work, and the more specifically it applies.\n\n${parts.join("\n\n")}`;
}
