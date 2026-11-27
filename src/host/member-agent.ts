/**
 * The one agent an organisation member starts with (INV-2220, docs/109 §3), made in their personal
 * box when that box comes up, and written on the roster as their **home agent**.
 *
 * From the organisation's member template when an Admin set one (`memberTemplate` in `config.json`:
 * a `lumenbox-template/1` file on the server), else the built-in assistant. The built-in one is the
 * starter team's first agent — the one that talks to people, with every tool — under the name the
 * word tables give it; not the four of them, which are a personal installation's.
 *
 * Made once per person: only for somebody on the roster with no home agent written down, in a box
 * that is theirs alone and has no agent yet — and the caller asks only for the box the installation
 * made for them (at activation or at first use), never for one a member made by hand. A person who deleted or replaced their agent, a box an
 * Admin moved to somebody else, and a second box are all left as they are. The agent needs its box
 * in the registry, and a personal box is attached there only once it has started, so that is when
 * this runs — not at the reservation.
 */

import { readFileSync } from "node:fs";
import type { AgentRecord, AgentRegistry } from "../agents/registry.ts";
import type { BoxEntry } from "../box/boxes.ts";
import type { Principals } from "./principals.ts";
import { parseTemplate, type BotTemplate } from "./template.ts";

export interface MemberAgentDeps {
  registry: Pick<AgentRegistry, "boxById" | "agentsIn" | "create">;
  principals: Pick<Principals, "reload" | "byId" | "installation" | "setHomeAgent">;
  /** The built-in assistant's profile: the starter team's first agent, named in this person's language. */
  assistant(owner: string): { name: string; title: string; description: string; tools?: readonly string[] };
  /** The path of the organisation's member template, when an Admin set one. */
  templatePath(): string | undefined;
  /** The template import the page uses, into this box, on this person's behalf. */
  importTemplate(template: BotTemplate, boxId: string, owner: string): AgentRecord;
  log(line: string): void;
}

/** The person a box is for when it is one person's alone. */
function soleMember(box: BoxEntry): string | undefined {
  return Array.isArray(box.members) && box.members.length === 1 ? box.members[0] : undefined;
}

/** Called when a personal box has come up. Returns the agent it made, or undefined when none was owed. */
export function ensureHomeAgent(boxId: string, deps: MemberAgentDeps): AgentRecord | undefined {
  const { registry, principals } = deps;
  const box = registry.boxById(boxId), owner = box === undefined ? undefined : soleMember(box);
  if (owner === undefined) return undefined;
  principals.reload();
  const person = principals.byId(owner);
  if (principals.installation().mode !== "organisation" || person === undefined || person.id !== owner || person.homeAgentId !== undefined) return undefined;
  if (registry.agentsIn(boxId).length > 0) return undefined;
  const agent = fromTemplate(boxId, owner, deps) ?? registry.create({ ...deps.assistant(owner), boxId, ownerUserId: owner });
  principals.setHomeAgent(owner, agent.id);
  deps.log(`home agent for ${owner}: ${agent.profile.name} (${agent.id}) in ${boxId}${agent.profile.importedFrom !== undefined ? ", from the organisation's member template" : ""}`);
  return agent;
}

/** The member template's agent; undefined when none is set or it cannot be used, which is said and falls back to the assistant. */
function fromTemplate(boxId: string, owner: string, deps: MemberAgentDeps): AgentRecord | undefined {
  const path = deps.templatePath();
  if (path === undefined || path.trim() === "") return undefined;
  try {
    const parsed = parseTemplate(readFileSync(path, "utf8"));
    if ("problem" in parsed) throw new Error(parsed.problem);
    return deps.importTemplate(parsed.template, boxId, owner);
  } catch (error) {
    deps.log(`member template ${path} was not used for ${owner}: ${error instanceof Error ? error.message : String(error)}; the built-in assistant was made instead`);
    return undefined;
  }
}
