/**
 * Whether this installation's own box can run here, and what follows when it cannot (INV-2310,
 * docs/112 §1, §3 rule 1, §5.1).
 *
 * Every installation has one box of its own. On the desktop it is the Docker container on this
 * computer. On an organisation whose sandboxes run on Kubernetes it is never started — unless an
 * Admin attached an organisation node to serve as it. A box that cannot run here is not shown
 * anywhere a person looks: not in the sidebar, the box picker or getting started, and no agent in it
 * answers a chat or a side-door call.
 *
 * Installations opened once by 0.4.10–0.4.12 already hold the starter team in that box. Its
 * records are kept; the Admins' Settings → Computers names those agents and offers to delete them
 * (`strandedAgentsRoute`), which archives their records as deleting any agent does.
 */

import type { AgentRecord, AgentRegistry } from "../agents/registry.ts";
import { apiError } from "./api-error.ts";

/** Whether an installation starts with the starter team: not one whose sandboxes run on Kubernetes, where its own box never starts (docs/109 §3). */
export const startsWithStarterTeam = (backend: { backend: string }): boolean => backend.backend !== "kubernetes";

/** The installation's own box runs here: anywhere but Kubernetes, and there only through an attached node. */
export function installationBoxRuns(kubernetes: boolean, provisionerKind: string): boolean {
  return !kubernetes || provisionerKind === "attached";
}

type Routing = Pick<AgentRegistry, "list" | "tryGet" | "boxOf" | "resolve">;

/** The registry as who-answers-a-chat sees it: without the agents of a box that cannot run here. */
export function runnableAgents(registry: Routing, hidden: () => string | undefined): Routing {
  const here = (agent: AgentRecord | undefined) => agent !== undefined && registry.boxOf(agent.id).id !== hidden();
  return {
    list: () => registry.list().filter(here),
    tryGet: id => { const agent = registry.tryGet(id); return here(agent) ? agent : undefined; },
    boxOf: id => registry.boxOf(id),
    resolve: name => {
      const agent = registry.resolve(name);
      if (!here(agent)) throw new Error(`No agent named ${name} here.`);
      return agent;
    },
  };
}

interface StrandedDeps {
  /** The installation's own box, when it cannot run here; undefined when it can. */
  hidden(): string | undefined;
  registry: Pick<AgentRegistry, "list" | "agentsIn" | "remove">;
  busy(): readonly string[];
  readJson(): Promise<Record<string, unknown>>;
  refusedAdmin(): boolean;
  log(line: string): void;
}

/** The agents in the box that cannot run here, for the Admins: read, and delete with their records archived. */
export async function strandedAgentsRoute(route: string, deps: StrandedDeps): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "GET /api/boxes/stranded" && route !== "POST /api/boxes/stranded/delete") return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  const box = deps.hidden(), stranded = box === undefined ? [] : deps.registry.agentsIn(box);
  if (route === "GET /api/boxes/stranded") return { status: 200, body: { agents: stranded.map(agent => ({ id: agent.id, name: agent.profile.name })) } };
  const asked = (await deps.readJson()).agentIds, ids = Array.isArray(asked) ? asked.map(String) : [];
  const chosen = stranded.filter(agent => ids.includes(agent.id));
  if (chosen.length === 0) return { status: 404, body: apiError("agent-unknown", { agent: ids.join(", ") }) };
  if (chosen.some(agent => deps.busy().includes(agent.id))) return { status: 409, body: apiError("agent-busy") };
  if (chosen.length >= deps.registry.list().length) return { status: 400, body: apiError("agent-last") };
  for (const agent of chosen) {
    const { archivedTo } = deps.registry.remove(agent.id, { archive: true });
    deps.log(`deleted agent ${agent.profile.name} from the box that cannot run here; records archived to ${archivedTo}`);
  }
  return { status: 200, body: { deleted: chosen.map(agent => agent.id) } };
}
