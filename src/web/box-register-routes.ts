/**
 * How a machine somewhere else registers its box daemon here (`POST /api/boxes/register`), before
 * the UI's token gate: the caller holds no UI credential, only what proves the registration.
 * Three ways in, each checked here and nothing else on this path reachable:
 *
 *   - **a connection code** an Admin minted (INV-434), redeemed once into a runner credential;
 *   - **a runner credential**, for a reconnect of a box that joined by a code;
 *   - **a node credential** (INV-1697, docs/96 §4), which an organisation issued when an Admin
 *     signed in to it on the node. A node registers each of its boxes with it and repeats the
 *     registration as its heartbeat; every box it registers belongs to the node, and revoking the
 *     node cuts them all off.
 *
 * An organisation takes boxes only from its nodes and from an Admin's `box attach` (docs/96 §8 Q3):
 * a code is refused there, so a person's own machine cannot hand the organisation a box by
 * redeeming one. `GET /api/boxes/register` says which ways this installation takes, so `box connect`
 * can refuse before it sends a daemon token anywhere.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRegistry } from "../agents/registry.ts";
import { attachedBox, BOX_NAME, type BoxEntry } from "../box/boxes.ts";
import type { ConnectCodeStore } from "../box/connect-codes.ts";
import type { BundleStore, Repository } from "../host/bundles.ts";
import { recordHostBoxBundle } from "../host/host-box.ts";
import { apiError } from "./api-error.ts";

type Reply = { status: number; body: unknown };

export interface BoxRegisterDeps {
  readJson: () => Promise<Record<string, unknown>>;
  connectCodes: ConnectCodeStore;
  registry: Pick<AgentRegistry, "boxById" | "updateBox" | "listBoxes">;
  orchestrator: {
    attachBox(entry: BoxEntry): Promise<{ connected: boolean; detail: string }>;
    reconnectBox(entry: BoxEntry): Promise<{ connected: boolean; detail: string }>;
    isConnected(boxId: string): boolean;
    bundles: BundleStore;
  };
  installationMode: () => "single-machine" | "organisation";
  home: () => string;
  log: (line: string) => void;
}

/** The ways in this installation takes: an organisation's nodes, or a personal installation's codes. */
export function registrationWays(mode: "single-machine" | "organisation"): { installation: string; takes: string[] } {
  return mode === "organisation" ? { installation: "organisation", takes: ["node", "runner"] } : { installation: "single-machine", takes: ["code", "runner"] };
}

/** The granted directories a node's native environment sends, checked: absolute paths, ro or rw. */
function repositoriesOf(raw: unknown): Repository[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Repository[] = [];
  for (const item of raw) {
    const entry = item as { path?: unknown; mode?: unknown };
    if (typeof entry?.path !== "string" || !entry.path.startsWith("/") || (entry.mode !== "ro" && entry.mode !== "rw")) return undefined;
    out.push({ path: entry.path, mode: entry.mode });
  }
  return out;
}

export async function boxRegisterRoute(route: string, deps: BoxRegisterDeps): Promise<Reply | undefined> {
  if (route === "GET /api/boxes/register") return { status: 200, body: registrationWays(deps.installationMode()) };
  if (route !== "POST /api/boxes/register") return undefined;
  const { connectCodes, registry, orchestrator, log } = deps;
  const body = await deps.readJson();
  const name = String(body.name ?? "").trim();
  const baseUrl = String(body.baseUrl ?? "").trim();
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const version = typeof body.version === "string" ? body.version.trim() : undefined;
  const writeToken = (boxName: string): string => {
    const dir = join(deps.home(), "boxes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tokenFile = join(dir, `${boxName}.token`);
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    return tokenFile;
  };

  if (typeof body.node === "string" && body.node.trim() !== "") return registerNodeBox(body, { name, baseUrl, token, version, writeToken }, deps);

  if (typeof body.runner === "string" && body.runner.trim() !== "") {
    // A reconnect: the same registration, idempotent; a new address if it moved.
    const verdict = connectCodes.verifyRunner(body.runner);
    if (!verdict.ok) {
      log(`boxes: a reconnect was refused (${verdict.why})`);
      return { status: verdict.why === "revoked" ? 403 : 401, body: apiError(verdict.why === "revoked" ? "box-revoked-here" : "runner-unknown") };
    }
    const entry = registry.boxById(verdict.registration.boxId);
    if (entry === undefined) return { status: 410, body: apiError("credential-box-gone") };
    if (baseUrl !== "" && token !== "") registry.updateBox(entry.id, { endpoint: { baseUrl, tokenFile: writeToken(entry.name) } });
    connectCodes.seen(entry.id, version);
    const result = await orchestrator.reconnectBox(registry.boxById(entry.id)!);
    log(`boxes: ${entry.name} reconnected: ${result.detail}`);
    return { status: 200, body: { boxId: entry.id, name: entry.name, ...result, state: connectCodes.stateOf(entry.id, result.connected) } };
  }

  // A code: never on an organisation, which takes boxes only from its nodes and its Admins (docs/96 §8 Q3).
  if (deps.installationMode() === "organisation") {
    log("boxes: a connection code was refused: an organisation takes boxes from its nodes and its Admins' box attach only");
    return { status: 403, body: apiError("box-code-organisation") };
  }
  const redeemed = connectCodes.redeem(String(body.code ?? ""));
  if (!redeemed.ok) {
    log(`boxes: a connection code was refused (${redeemed.why})`);
    const code = ({ unknown: "connect-code-unknown", expired: "connect-code-expired", used: "connect-code-used", "wrong-installation": "connect-code-elsewhere" } as const)[redeemed.why];
    return { status: redeemed.why === "wrong-installation" ? 403 : 409, body: apiError(code) };
  }
  const boxName = redeemed.name ?? name;
  if (boxName === "" || baseUrl === "" || token === "") return { status: 400, body: apiError("box-registration-incomplete") };
  let entry: BoxEntry;
  try {
    entry = attachedBox({ name: boxName, baseUrl, tokenFile: writeToken(boxName), ...(body.kind === "host" ? { kind: "host" as const } : {}) });
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  try {
    const result = await orchestrator.attachBox(entry);
    const runner = connectCodes.register({ boxId: entry.id, name: entry.name, ...(version !== undefined ? { version } : {}) });
    log(`boxes: ${entry.name} (${entry.id}) registered with a connection code: ${result.detail}`);
    return { status: 200, body: { boxId: entry.id, name: entry.name, runner, ...result, state: connectCodes.stateOf(entry.id, result.connected) } };
  } catch (error) {
    return { status: 409, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * A node registering one of its boxes, or saying again that it is there (the heartbeat): the same
 * box on the same node, a new address if it moved. A new native environment box joins with nobody
 * in it — an Admin opens it to members once its shell is confined (node-routes.ts) — and with the
 * bundle that records the directories it may reach; a Docker box is the organisation's like any.
 */
async function registerNodeBox(
  body: Record<string, unknown>,
  input: { name: string; baseUrl: string; token: string; version: string | undefined; writeToken: (name: string) => string },
  deps: BoxRegisterDeps
): Promise<Reply> {
  const { connectCodes, registry, orchestrator, log } = deps;
  const verdict = connectCodes.verifyNode(String(body.node));
  if (!verdict.ok) {
    log(`boxes: a node registration was refused (${verdict.why})`);
    return { status: verdict.why === "revoked" ? 403 : 401, body: apiError(verdict.why === "revoked" ? "node-revoked" : "node-unknown") };
  }
  const node = verdict.node;
  const kind = body.kind === "host" ? ("host" as const) : ("attached" as const);
  if (!BOX_NAME.test(input.name) || input.baseUrl === "" || input.token === "") return { status: 400, body: apiError("box-registration-incomplete") };
  connectCodes.nodeSeen(node.id, input.version);
  const known = connectCodes.nodeBox(node.id, input.name);
  const entry = known === undefined ? undefined : registry.boxById(known.boxId);
  if (entry !== undefined) {
    const moved = entry.endpoint?.baseUrl !== input.baseUrl.replace(/\/+$/, "");
    if (moved) registry.updateBox(entry.id, { endpoint: { baseUrl: input.baseUrl, tokenFile: input.writeToken(entry.name) } });
    connectCodes.seen(entry.id, input.version);
    const result = moved || !orchestrator.isConnected(entry.id) ? await orchestrator.reconnectBox(registry.boxById(entry.id)!) : { connected: true, detail: `${entry.name}: connected` };
    return { status: 200, body: { boxId: entry.id, name: entry.name, node: node.id, ...result, state: connectCodes.stateOf(entry.id, result.connected) } };
  }
  if (registry.listBoxes().some(box => box.name === input.name)) return { status: 409, body: apiError("node-box-name-taken", { name: input.name }) };
  const repositories = kind === "host" ? repositoriesOf(body.repositories) : [];
  if (repositories === undefined) return { status: 400, body: apiError("node-box-roots-invalid") };
  let created: BoxEntry;
  try {
    created = attachedBox({
      name: input.name, baseUrl: input.baseUrl, tokenFile: input.writeToken(input.name), kind,
      ...(typeof body.workDir === "string" && body.workDir.startsWith("/") ? { workDir: body.workDir } : {}),
      // The native environment is nobody's until an Admin opens it, and only once it is confined (INV-1700).
      ...(kind === "host" ? { members: [] } : {}),
    });
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  if (kind === "host") recordHostBoxBundle(orchestrator.bundles, created.name, repositories, `a machine of this organisation (node ${node.name})`);
  try {
    const result = await orchestrator.attachBox(created);
    connectCodes.register({ boxId: created.id, name: created.name, nodeId: node.id, ...(input.version !== undefined ? { version: input.version } : {}) });
    log(`boxes: ${created.name} (${created.id}, ${kind === "host" ? "native environment" : "docker"}) registered by node ${node.name}: ${result.detail}`);
    return { status: 200, body: { boxId: created.id, name: created.name, node: node.id, ...result, state: connectCodes.stateOf(created.id, result.connected) } };
  } catch (error) {
    return { status: 409, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}
