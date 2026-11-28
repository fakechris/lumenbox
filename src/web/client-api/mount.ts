/**
 * The client API wired to the server's own parts, so `server.ts` mounts it in two lines (docs/106 §4).
 * Everything the frame and the handlers read comes through `ClientApiDeps`; this is the one place
 * that names the server's objects.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { AgentRegistry } from "../../agents/registry.ts";
import { attentionFor } from "../../host/attention.ts";
import type { Principals } from "../../host/principals.ts";
import type { Task } from "../../host/tasks.ts";
import { tr } from "../../i18n/messages.ts";
import type { Locale } from "../../i18n/locale.ts";
import { ACCESS_PREFIX, DeviceStore } from "../device-credentials.ts";
import { DeviceSignIns, type PairingFor } from "../device-sign-in.ts";
import { reachOf } from "../reach.ts";
import { IdempotencyStore } from "../idempotency.ts";
import type { McpTokenStore } from "../mcp-tokens.ts";
import type { Attempt, SignInDoor, SignInGuard } from "../sign-in-limits.ts";
import type { TokenRecord } from "../token-ledger.ts";
import type { DeviceAuth } from "./auth.ts";
import { CHANGES_LEDGER, ChangeLedger } from "./change-ledger.ts";
import { type ClientWorld, clientApi } from "./frame.ts";

export const CLIENT_API_IDEMPOTENCY = "client-api-idempotency.jsonl";
/** Devices' credentials, as hashes (device-credentials.ts). */
export const DEVICES_FILE = "devices.json";

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
  /** Told of every task made or changed: the board's own hooks (TaskStore.onCreate, onChange). */
  onTask(listener: (task: Task) => void): void;
  /** `tokens.jsonl` (token-ledger.ts): every device signed in, rotated and ended goes there with who. */
  recordToken(record: TokenRecord): void;
  /** The doors a person signs in through on the web now, and the installation's public address (sign-in.ts). */
  doors(): readonly { id: string; name: string; type: string }[];
  publicUrl(): string | undefined;
  /** A person signed in on a device: their own computer, if they are owed one (auto-personal-box.ts `arrive`). */
  arrived(personId: string, locale: Locale): void;
  /** Open desktops let go of anybody whose access ended (open-desktops.ts). */
  desktops: { recheck(): void };
}) {
  const { registry, principals } = server;
  // What changed, on disk, for a client that comes back later (change-ledger.ts).
  const changes = new ChangeLedger(join(server.home, CHANGES_LEDGER), server.log);
  server.onTask(task => { changes.append({ type: "work", id: task.id, op: "upsert", requester: task.requester, ...(task.assigneeId !== undefined ? { assigneeId: task.assigneeId } : {}) }); });
  // Agents change in files the registry reads, with no event of their own: what a client shows of each is fingerprinted,
  // and a change to the print, a new agent or one gone is written. On start, against the ledger's last word, so a
  // restart announces only what did change; then before each read of the ledger and every few seconds.
  const printOf = (id: string): { print: string; boxId: string } => {
    const record = registry.tryGet(id)!, box = registry.boxOf(id);
    const shown = [record.profile.name, record.profile.title ?? "", record.profile.description, record.profile.tags ?? [], record.profile.hidden === true, box.id, box.name];
    return { print: createHash("sha256").update(JSON.stringify(shown)).digest("base64url").slice(0, 16), boxId: box.id };
  };
  const noteAgents = (): void => {
    const last = changes.lastOf("agent"), present = new Set<string>();
    for (const record of registry.list()) {
      present.add(record.id);
      const now = printOf(record.id), before = last.get(record.id);
      if (before === undefined || before.op === "delete" || before.print !== now.print) changes.append({ type: "agent", id: record.id, op: "upsert", ...now });
    }
    for (const [id, line] of last) if (line.op !== "delete" && !present.has(id)) changes.append({ type: "agent", id, op: "delete", ...(line.boxId !== undefined ? { boxId: line.boxId } : {}) });
  };
  noteAgents();
  const agentWatch = setInterval(noteAgents, 5_000);
  agentWatch.unref();
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
    changes,
    noteAgents,
  };
  const attempt = (req: IncomingMessage) => server.attemptFrom(req, "client-api");
  const devices = new DeviceStore(join(server.home, DEVICES_FILE), server.log, server.recordToken);
  const signIns = new DeviceSignIns();
  /** A device's sign-in is its person's while they are on the roster and, made from a sign-in, that sign-in is still one of theirs. */
  const holds = (holder: { principalId: string; identity: string; via: "sign-in" | "person" }): boolean => {
    principals.reload();
    if (principals.byId(holder.principalId) === undefined) return false;
    return holder.via === "person" || (principals.isKnown(holder.identity) && principals.resolve(holder.identity).id === holder.principalId);
  };
  const deviceAuth: DeviceAuth = {
    providers: locale => server.doors().map(door => ({
      id: door.id, type: door.type, displayName: door.name.toLowerCase() === door.type ? tr(`page.bootstrap.vendor-${door.type}`, locale) : door.name,
    })),
    start: input => {
      const base = server.publicUrl()?.trim().replace(/\/+$/, "");
      if (base === undefined || base === "" || !server.doors().some(door => door.id === input.providerId)) return undefined;
      const started = signIns.start(input);
      return { authorizationUrl: `${base}/auth/${encodeURIComponent(input.providerId)}?device=${started.id}`, expiresAt: started.expiresAt };
    },
    exchange: (code, verifier, check) => signIns.exchange(code, verifier, check),
    pair: code => signIns.pair(code),
    holds,
    signIn: input => devices.signIn(input),
    credentialOf: token => { const found = devices.clientFor(token, holds); return "credential" in found ? found.credential : undefined; },
    refresh: token => devices.refresh(token, holds),
    list: id => devices.list(id),
    remove: (id, why, by, may) => devices.remove(id, why, by, may),
    ended: () => ended(),
    arrived: server.arrived,
    askedWords: locale => tr("device.asked-to-join", locale),
  };
  const api = clientApi({
    world,
    // A device's access token to the device store, any other to the token store: each prefix has one home.
    tokens: {
      clientFor: (presented, now) => (presented?.startsWith(ACCESS_PREFIX) === true ? devices.clientFor(presented, holds) : server.tokens.clientFor(presented, now)),
      touch: (id, now) => (id.startsWith("dev_") ? devices.touch(id) : server.tokens.touch(id, now)),
    },
    devices: deviceAuth,
    person: id => {
      server.principals.reload(); // the roster as it is now: a person removed a moment ago is removed here too
      const person = server.principals.byId(id);
      return person === undefined ? undefined : { id: person.id, name: person.name, role: person.role };
    },
    installationMode: () => server.principals.installation().mode,
    version: server.version,
    homeAgentOf: id => server.homeOf(id)?.id,
    signIns: {
      blocked: req => server.signIns().blocked(attempt(req)), failed: (req, reason) => server.signIns().failed(attempt(req), reason),
      succeeded: (req, account) => server.signIns().succeeded({ ...attempt(req), account }),
    },
    address: req => attempt(req).address,
    idempotency: new IdempotencyStore({ ttlMs: 24 * 60 * 60_000, persistTo: join(server.home, CLIENT_API_IDEMPOTENCY) }),
    secretIdempotency: new IdempotencyStore({ ttlMs: 30_000 }),
    log: server.log,
  });
  /** A credential ended here or by a person's access ending: what it had open lets go now. */
  function ended(): void {
    api.recheckStreams();
    server.desktops.recheck();
  }
  return {
    ...api,
    /** The door's half of a device's sign-in (door-sign-in.ts). */
    doorSignIn: { take: (id: string) => signIns.take(id), finish: (id: string, outcome: Parameters<DeviceSignIns["finish"]>[1]) => signIns.finish(id, outcome) },
    /** The page's half (device-routes.ts): a pairing code to show, a person's devices, and ending one. */
    devices: {
      showPairing: (pairing: PairingFor, by: string) => {
        const shown = signIns.showPairing(pairing);
        server.recordToken({
          at: new Date().toISOString(), event: "pairing-shown", kind: "device", for: pairing.principalId, by, expiresAt: new Date(shown.expiresAt).toISOString(),
          ...(pairing.signedInAt !== undefined ? { signedInAt: pairing.signedInAt } : {}),
        });
        return shown;
      },
      list: (principalId: string) => devices.list(principalId),
      remove: (id: string, by: string, may: (device: { principalId: string }) => boolean) => { const done = devices.remove(id, "removed", by, may); if (done) ended(); return done; },
    },
    /**
     * Somebody's access ended — a directory sync's *left*, an Admin removing them, a sign-out everywhere: their
     * devices end now (`signInOnly`: only those made from these sign-ins), and their open streams and desktops close.
     */
    endAccess(ids: readonly string[], signInOnly: boolean, by: string): void {
      devices.endFor(ids, signInOnly, by);
      signIns.dropFor(ids, signInOnly);
      ended();
    },
    /** When the server stops: no agent diff of an old registry beside a new one, and no stream left open. */
    close: () => { clearInterval(agentWatch); changes.close(); },
  };
}
