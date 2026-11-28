/** `GET /agents` and `GET /agents/{id}` (docs/106 §4.2): an `Agent` built from what the registry and the bus know. */

import type { AgentFact, Call } from "./frame.ts";
import { refuse } from "./frame.ts";
import { decodeCursor, encodeCursor, limitOf, sightOf } from "./visibility.ts";

function agentOf(fact: AgentFact, home: string | undefined) {
  return {
    id: fact.id,
    name: fact.name,
    ...(fact.title !== undefined && fact.title !== "" ? { title: fact.title } : {}),
    ...(fact.description !== "" ? { description: fact.description } : {}),
    boxId: fact.boxId,
    boxName: fact.boxName,
    teams: [...fact.teams],
    status: fact.working ? "working" : "idle",
    isHome: fact.id === home,
  };
}

const position = (value: unknown): value is [string, string] => Array.isArray(value) && value.length === 2 && value.every(part => typeof part === "string");
const before = (a: readonly [string, string], b: readonly [string, string]): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

export function listAgents(call: Call) {
  const sight = sightOf(call);
  const home = call.deps.homeAgentOf(call.caller!.person.id);
  const rows = call.deps.world.agents().filter(fact => !fact.hidden && sight.agent(fact.id))
    .map(fact => ({ fact, key: [fact.name, fact.id] as [string, string] })).sort((a, b) => (before(a.key, b.key) ? -1 : 1));
  const after = decodeCursor(call.params.cursor, "agents", position);
  const rest = after === undefined ? rows : rows.filter(row => before(after, row.key));
  const page = rest.slice(0, limitOf(call));
  return {
    items: page.map(row => agentOf(row.fact, home)),
    ...(rest.length > page.length ? { nextCursor: encodeCursor(page.at(-1)!.key, "agents") } : {}),
  };
}

export function getAgent(call: Call) {
  const id = String(call.params.id);
  const fact = call.deps.world.agents().find(agent => agent.id === id);
  if (fact === undefined || !sightOf(call).agent(id)) return refuse("api-not-found");
  return agentOf(fact, call.deps.homeAgentOf(call.caller!.person.id));
}
