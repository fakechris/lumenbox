/**
 * The client API wired to the server's own parts, so `server.ts` mounts it in two lines (docs/106 §4).
 * Everything the frame and the handlers read comes through `ClientApiDeps`; this is the one place
 * that names the server's objects.
 */

import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { AgentRegistry } from "../../agents/registry.ts";
import { attentionFor } from "../../host/attention.ts";
import type { Principals } from "../../host/principals.ts";
import type { Task } from "../../host/tasks.ts";
import { reachOf } from "../reach.ts";
import { IdempotencyStore } from "../idempotency.ts";
import type { McpTokenStore } from "../mcp-tokens.ts";
import type { Attempt, SignInDoor, SignInGuard } from "../sign-in-limits.ts";
import { type ClientWorld, clientApi } from "./frame.ts";

export const CLIENT_API_IDEMPOTENCY = "client-api-idempotency.jsonl";

export function mountClientApi(server: {
  tokens: McpTokenStore;
  principals: Principals;
  homeOf(personId: string): { id: string } | undefined;
  version: string;
  /** The limiter as it is now: it is replaced when the exposure level is read, after this is built. */
  signIns(): SignInGuard;
  attemptFrom(req: IncomingMessage, door: SignInDoor): Attempt;
  home: string;
  log(line: string): void;
  registry: AgentRegistry;
  /** The board's work now; empty before the orchestrator has a board. */
  tasks(): readonly Task[];
  /** Whether an agent is in a turn now. */
  working(agentId: string): boolean;
  /** Boxes the installation shows nobody (reach.ts). */
  unavailable(): ReadonlySet<string>;
  /** The page's two questions about a task in flight, as its attention asks them. */
  taskActive(task: Task): boolean;
  checkPending(task: Task): boolean;
}) {
  const { registry, principals } = server;
  const world: ClientWorld = {
    reachOf: person => reachOf(() => ({ personId: person.id, known: true }), {
      boxById: id => registry.boxById(id), boxIdOf: id => (registry.has(id) ? registry.boxOf(id).id : undefined), unavailable: server.unavailable,
    }),
    agents: () => registry.list().map(record => {
      const box = registry.boxOf(record.id);
      return {
        id: record.id, name: record.profile.name, ...(record.profile.title !== undefined ? { title: record.profile.title } : {}), description: record.profile.description,
        boxId: box.id, boxName: box.name, teams: record.profile.tags ?? [], hidden: record.profile.hidden === true, working: server.working(record.id),
      };
    }),
    tasks: server.tasks,
    // The page's own attention (GET /api/attention), for one person and these tasks: what makes the "waiting on you" mark and the board's order.
    attention: (person, tasks) => attentionFor({
      principalId: person.id, identities: principals.byId(person.id)?.identities ?? [], tasks, questions: [],
      nameOf: id => registry.tryGet(id)?.profile.name ?? principals.byId(id)?.name ?? id,
      agentIds: new Set(registry.list().map(agent => agent.id)), personIds: new Set(principals.list().flatMap(entry => [entry.id, ...entry.identities])),
      active: server.taskActive, checkPending: server.checkPending,
    }),
    actor: id => {
      const agent = registry.tryGet(id);
      if (agent !== undefined) return { kind: "agent", name: agent.profile.name };
      const person = principals.byId(id) ?? (principals.isKnown(id) ? principals.resolve(id) : undefined);
      return person === undefined ? undefined : { kind: "person", name: person.name };
    },
  };
  const attempt = (req: IncomingMessage) => server.attemptFrom(req, "client-api");
  return clientApi({
    world,
    tokens: server.tokens,
    person: id => {
      server.principals.reload(); // the roster as it is now: a person removed a moment ago is removed here too
      const person = server.principals.byId(id);
      return person === undefined ? undefined : { id: person.id, name: person.name, role: person.role };
    },
    installationMode: () => server.principals.installation().mode,
    version: server.version,
    homeAgentOf: id => server.homeOf(id)?.id,
    signIns: { blocked: req => server.signIns().blocked(attempt(req)), failed: (req, reason) => server.signIns().failed(attempt(req), reason) },
    address: req => attempt(req).address,
    idempotency: new IdempotencyStore({ ttlMs: 24 * 60 * 60_000, persistTo: join(server.home, CLIENT_API_IDEMPOTENCY) }),
    log: server.log,
  });
}
