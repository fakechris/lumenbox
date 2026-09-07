/**
 * Talking to the Kubernetes API with no client library.
 *
 * Deliberately a thin REST client over `node:https` rather than `@kubernetes/client-node`: this
 * project carries three runtime dependencies and means to keep it that way, and the allocator only
 * needs a dozen verbs on four object kinds. The cost is that credentials and a sliver of the object
 * model are reimplemented here; the return is that nothing generated, and nothing with its own
 * idea of style, enters the tree.
 *
 * The interface is narrow on purpose — `KubeApi` is the whole contract, and it is also the test's
 * contract, the same pattern as the compose allocator's `managerFactory`: the suite has to pass
 * with no cluster and no network, so the real client and the in-memory fake stand behind one seam.
 *
 * Two credential sources, in order:
 *
 *   1. **In-cluster.** The ServiceAccount files Kubernetes mounts into every pod
 *      (`/var/run/secrets/kubernetes.io/serviceaccount/{token,ca.crt}`) plus
 *      `KUBERNETES_SERVICE_HOST/PORT`. This is the production shape: the control plane runs in the
 *      cluster it allocates into.
 *   2. **A kubeconfig.** `KUBECONFIG`, else `~/.kube/config`, parsed by the small YAML reader below
 *      — there is no YAML dependency to reach for. Only the shapes a client needs are understood:
 *      a server, a CA (inline or by path), and a token or client certificate pair. An `exec:`
 *      credential plugin (gke, eks, any SSO helper) is *refused loudly* rather than silently
 *      mishandled, because silently producing unauthenticated 401s against a real cluster is the
 *      worst version of this failure.
 */

import { existsSync, readFileSync } from "node:fs";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

/** A name and the labels it carries. Everything else about an object is kind-specific. */
export interface KubeObjectMeta {
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

/**
 * The pieces of a Pod this allocator writes and reads.
 *
 * `spec` is intentionally `Record<string, unknown>`: the allocator builds it, the API server
 * validates it, and re-declaring the whole Pod schema here would be a copy of someone else's
 * documentation that rots on contact. Only `status` is read back, and only the two fields the
 * readiness wait needs.
 */
export interface KubePod {
  metadata: KubeObjectMeta;
  spec: Record<string, unknown>;
  status?: {
    phase?: string;
    conditions?: readonly { type: string; status: string }[];
  };
}

export interface KubeService {
  metadata: KubeObjectMeta;
  spec: Record<string, unknown>;
}

export interface KubePvc {
  metadata: KubeObjectMeta;
  spec: Record<string, unknown>;
}

export interface KubeSecret {
  metadata: KubeObjectMeta;
  /** base64 values, as the API speaks them. Callers base64-encode; this type does not pretend. */
  data: Record<string, string>;
}

/**
 * The verbs the allocator needs, nothing more.
 *
 * Every `apply` is create-or-replace: allocation is retried after timeouts, so each verb must be
 * safe to issue twice against the same name. Every `delete` tolerates absence for the same
 * reason — destroy after a half-finished create is a normal path, not an error.
 */
export interface KubeApi {
  applyPod(pod: KubePod): Promise<void>;
  getPod(name: string): Promise<KubePod | undefined>;
  deletePod(name: string): Promise<void>;
  applyService(service: KubeService): Promise<void>;
  getService(name: string): Promise<KubeService | undefined>;
  deleteService(name: string): Promise<void>;
  applyPvc(pvc: KubePvc): Promise<void>;
  /**
   * Looked up, not only written, because `locate` tells a stopped box (pod and service deleted,
   * volumes kept) apart from a gone one by whether its work volume survives.
   */
  getPvc(name: string): Promise<KubePvc | undefined>;
  deletePvc(name: string): Promise<void>;
  applySecret(secret: KubeSecret): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  /** Every pod carrying these labels — how a sweep asks "what does this allocator own". */
  listByLabel(selector: Record<string, string>): Promise<KubePod[]>;
}

export class KubernetesError extends Error {
  constructor(
    message: string,
    /** The HTTP status, when the API server answered at all. Undefined means the call never left. */
    readonly status?: number
  ) {
    super(message);
    this.name = "KubernetesError";
  }
}

/** How the client proves itself to the API server. */
export interface KubeCredentials {
  /** e.g. `https://kubernetes.default.svc` — no trailing slash, no path. */
  server: string;
  /** Bearer token, when token auth is used. */
  token?: string;
  /** CA bundle the server's certificate is checked against. */
  ca?: Buffer;
  /** Client certificate and key, the other auth shape a kubeconfig carries. */
  clientCert?: Buffer;
  clientKey?: Buffer;
}

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * Credentials from the pod's own ServiceAccount, or undefined when not running in a cluster.
 *
 * Undefined rather than an error, because "am I in a cluster" is a legitimate question with a
 * legitimate no — the caller falls through to the kubeconfig.
 */
export function inClusterCredentials(env: NodeJS.ProcessEnv = process.env): KubeCredentials | undefined {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT;
  if (host === undefined || host === "") return undefined;
  const tokenPath = join(SERVICE_ACCOUNT_DIR, "token");
  if (!existsSync(tokenPath)) {
    // The variable says in-cluster but the mount says otherwise: half a deployment. Loud, because
    // silently falling through to someone's laptop kubeconfig would allocate boxes into whatever
    // cluster that happens to point at.
    throw new KubernetesError(
      `KUBERNETES_SERVICE_HOST is set but ${tokenPath} does not exist — the ServiceAccount is ` +
        `not mounted into this pod. Set automountServiceAccountToken: true on the control plane's ` +
        `ServiceAccount, or unset KUBERNETES_SERVICE_HOST.`
    );
  }
  const caPath = join(SERVICE_ACCOUNT_DIR, "ca.crt");
  return {
    server: `https://${host}:${port ?? "443"}`,
    token: readFileSync(tokenPath, "utf8").trim(),
    ca: existsSync(caPath) ? readFileSync(caPath) : undefined,
  };
}

/**
 * Credentials from a kubeconfig — the development shape, for `kind` and friends.
 *
 * Parsed by the minimal YAML reader in this file, because there is no YAML dependency and the
 * config shapes a client needs are a small, stable subset: flat scalars, maps, and lists of maps.
 * Anything outside that subset — anchors, block scalars, multi-line strings — is an error with a
 * line number, not a guess. A parser that guesses at YAML is how a silent misread of
 * `current-context` allocates tenant boxes into the production cluster the developer also has
 * credentials for.
 */
export function kubeconfigCredentials(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => Buffer = p => readFileSync(p)
): KubeCredentials {
  const path = env.KUBECONFIG ?? join(homedir(), ".kube", "config");
  if (!existsSync(path)) {
    throw new KubernetesError(
      `no in-cluster ServiceAccount and no kubeconfig at ${path}. Either run inside the cluster, ` +
        `or point KUBECONFIG at a config with token or client-certificate auth.`
    );
  }
  const config = parseMinimalYaml(readFile(path).toString("utf8"), path);
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new KubernetesError(`${path}: a kubeconfig is a mapping at the top level`);
  }
  const root = config as Record<string, unknown>;
  const currentContext = root["current-context"];
  if (typeof currentContext !== "string" || currentContext === "") {
    throw new KubernetesError(`${path}: no current-context — nothing says which cluster to use`);
  }

  const named = (list: unknown): Record<string, unknown> | undefined => {
    if (!Array.isArray(list)) return undefined;
    for (const entry of list) {
      if (typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).name === currentContext) {
        return entry as Record<string, unknown>;
      }
    }
    return undefined;
  };

  const context = named(root.contexts)?.context as Record<string, unknown> | undefined;
  if (context === undefined) {
    throw new KubernetesError(`${path}: current-context ${currentContext} is not in contexts`);
  }
  // A context names its cluster and user; find *those* entries, not the one sharing the
  // context's name — they coincide in kind-generated configs and diverge in hand-written ones.
  const clusterName = typeof context.cluster === "string" ? context.cluster : currentContext;
  const userName = typeof context.user === "string" ? context.user : currentContext;
  const byName = (list: unknown, name: string): Record<string, unknown> | undefined => {
    if (!Array.isArray(list)) return undefined;
    for (const entry of list) {
      if (typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).name === name) {
        return entry as Record<string, unknown>;
      }
    }
    return undefined;
  };
  const cluster = byName(root.clusters, clusterName)?.cluster as Record<string, unknown> | undefined;
  if (cluster === undefined) {
    throw new KubernetesError(`${path}: context ${currentContext} names cluster ${clusterName}, which is not in clusters`);
  }
  const server = cluster.server;
  if (typeof server !== "string" || !server.startsWith("http")) {
    throw new KubernetesError(`${path}: cluster ${clusterName} has no usable server URL`);
  }

  const ca = inlineOrFile(cluster, "certificate-authority", readFile);
  const user = byName(root.users, userName)?.user as Record<string, unknown> | undefined;
  if (user !== undefined && user.exec !== undefined) {
    // gke/eks/SSO helpers. Refused rather than executed: shelling out to a credential plugin from
    // inside an allocator is a supply chain and a hang nobody asked for, and pretending it worked
    // is worse.
    throw new KubernetesError(
      `${path}: user ${userName} authenticates with an exec plugin, which this client does not ` +
        `run. Either run the control plane in-cluster (ServiceAccount auth), or mint a token: ` +
        `kubectl create token <serviceaccount> and put it in this kubeconfig's user.token.`
    );
  }
  const token = typeof user?.token === "string" ? user.token : undefined;
  const clientCert = user === undefined ? undefined : inlineOrFile(user, "client-certificate", readFile);
  const clientKey = user === undefined ? undefined : inlineOrFile(user, "client-key", readFile);
  if (token === undefined && (clientCert === undefined || clientKey === undefined)) {
    throw new KubernetesError(
      `${path}: user ${userName} has neither a token nor a client certificate pair — nothing here ` +
        `can authenticate.`
    );
  }
  return { server: server.replace(/\/+$/, ""), token, ca, clientCert, clientKey };
}

/** A `*-data` field is inline base64; the bare name is a path. Both exist in the wild. */
function inlineOrFile(
  holder: Record<string, unknown>,
  base: string,
  readFile: (path: string) => Buffer
): Buffer | undefined {
  const inline = holder[`${base}-data`];
  if (typeof inline === "string" && inline !== "") return Buffer.from(inline, "base64");
  const file = holder[base];
  if (typeof file === "string" && file !== "") return readFile(file);
  return undefined;
}

/**
 * The small YAML subset a kubeconfig needs: nested maps, lists of maps or scalars, quoted or bare
 * scalars. Anything else fails loudly with a line number.
 *
 * Not a general YAML parser and not aspiring to be one — the day this file needs anchors is the
 * day the dependency question gets reopened, not the day a half-parser grows a third mode.
 */
export function parseMinimalYaml(text: string, source = "<yaml>"): unknown {
  interface Line {
    indent: number;
    text: string;
    line: number;
  }
  const lines: Line[] = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.includes("\t")) {
      throw new KubernetesError(`${source}:${i + 1}: a tab in the indentation — YAML forbids it`);
    }
    const stripped = raw.replace(/#.*$/, "").replace(/\s+$/, "");
    if (stripped.trim() === "" || stripped.trim() === "---") return;
    const indent = stripped.length - stripped.trimStart().length;
    lines.push({ indent, text: stripped.trimStart(), line: i + 1 });
  });

  const scalar = (raw: string, line: number): string => {
    if (raw === "" ) return "";
    if (raw.startsWith("|") || raw.startsWith(">")) {
      throw new KubernetesError(`${source}:${line}: block scalars are not understood by this parser`);
    }
    if (raw.startsWith("[") || raw.startsWith("{") || raw.startsWith("&") || raw.startsWith("*")) {
      throw new KubernetesError(`${source}:${line}: '${raw.slice(0, 12)}…' is outside the YAML subset this parser reads`);
    }
    if (
      (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
      (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
    ) {
      const inner = raw.slice(1, -1);
      // Double-quoted scalars may carry escapes; only the ones a config plausibly holds.
      return raw.startsWith('"')
        ? inner.replace(/\\(["\\n])/g, (_m, c: string) => (c === "n" ? "\n" : c))
        : inner.replace(/''/g, "'");
    }
    return raw;
  };

  const parseBlock = (list: Line[], at: number, indent: number): [unknown, number] => {
    const first = list[at];
    if (first === undefined) return [undefined, at];
    if (first.text.startsWith("- ") || first.text === "-") {
      const items: unknown[] = [];
      let i = at;
      while (i < list.length && list[i]!.indent === indent && (list[i]!.text.startsWith("- ") || list[i]!.text === "-")) {
        const head = list[i]!;
        const rest = head.text === "-" ? "" : head.text.slice(2);
        if (rest === "") {
          const [value, next] = parseBlock(list, i + 1, list[i + 1]?.indent ?? indent);
          items.push(value);
          i = next;
        } else if (rest.includes(":")) {
          // `- name: x` — a map whose first key rides on the dash line.
          const synthetic: Line[] = [{ indent: indent + 2, text: rest, line: head.line }];
          let j = i + 1;
          while (j < list.length && list[j]!.indent > indent) {
            synthetic.push(list[j]!);
            j++;
          }
          const [value] = parseMap(synthetic, 0, indent + 2);
          items.push(value);
          i = j;
        } else {
          items.push(scalar(rest, head.line));
          i++;
        }
      }
      return [items, i];
    }
    return parseMap(list, at, indent);
  };

  function parseMap(list: Line[], at: number, indent: number): [Record<string, unknown>, number] {
    const map: Record<string, unknown> = {};
    let i = at;
    while (i < list.length && list[i]!.indent >= indent && !list[i]!.text.startsWith("- ")) {
      const line = list[i]!;
      if (line.indent < indent) break;
      const colon = line.text.indexOf(":");
      if (colon <= 0) {
        throw new KubernetesError(`${source}:${line.line}: expected 'key: value', got '${line.text}'`);
      }
      const key = scalar(line.text.slice(0, colon), line.line);
      const rest = line.text.slice(colon + 1).trim();
      if (rest !== "") {
        map[key] = scalar(rest, line.line);
        i++;
      } else {
        const next = list[i + 1];
        // YAML lets a block *sequence* sit at the same indent as its parent key
        // (`clusters:`\n`- name: …`), which is exactly how kubeconfigs are written; a nested
        // *mapping* must be deeper.
        const isNestedMap = next !== undefined && next.indent > line.indent;
        const isSameIndentSequence =
          next !== undefined && next.indent === line.indent && (next.text.startsWith("- ") || next.text === "-");
        if (isNestedMap || isSameIndentSequence) {
          const [value, after] = parseBlock(list, i + 1, next.indent);
          map[key] = value;
          i = after;
        } else {
          map[key] = "";
          i++;
        }
      }
    }
    return [map, i];
  }

  if (lines.length === 0) return {};
  const [value] = parseBlock(lines, 0, lines[0]!.indent);
  return value;
}

/** The resource paths this client knows, keyed by kind so the verbs stay mechanical. */
const RESOURCES = {
  pods: "/api/v1/namespaces/{ns}/pods",
  services: "/api/v1/namespaces/{ns}/services",
  persistentvolumeclaims: "/api/v1/namespaces/{ns}/persistentvolumeclaims",
  secrets: "/api/v1/namespaces/{ns}/secrets",
} as const;

type ResourceKind = keyof typeof RESOURCES;

/**
 * The real client: one HTTPS request per verb, keep-alive off.
 *
 * No watch, no informers, no paging — the allocator's questions are all "this one name" or "pods
 * with these labels in one namespace", and a fleet of tenants does not make a list response large.
 * The day it does, `listByLabel` is where pagination lands, not a rewrite.
 */
export class HttpKubeApi implements KubeApi {
  private readonly agent: https.Agent;

  constructor(
    private readonly credentials: KubeCredentials,
    private readonly namespace: string,
    private readonly timeoutMs = 30_000
  ) {
    this.agent = new https.Agent({
      ca: credentials.ca,
      cert: credentials.clientCert,
      key: credentials.clientKey,
    });
  }

  applyPod(pod: KubePod): Promise<void> {
    return this.apply("pods", pod.metadata.name, { ...pod, apiVersion: "v1", kind: "Pod" });
  }
  async getPod(name: string): Promise<KubePod | undefined> {
    return (await this.get("pods", name)) as KubePod | undefined;
  }
  deletePod(name: string): Promise<void> {
    return this.remove("pods", name);
  }
  applyService(service: KubeService): Promise<void> {
    return this.apply("services", service.metadata.name, { ...service, apiVersion: "v1", kind: "Service" });
  }
  async getService(name: string): Promise<KubeService | undefined> {
    return (await this.get("services", name)) as KubeService | undefined;
  }
  deleteService(name: string): Promise<void> {
    return this.remove("services", name);
  }
  applyPvc(pvc: KubePvc): Promise<void> {
    return this.apply("persistentvolumeclaims", pvc.metadata.name, { ...pvc, apiVersion: "v1", kind: "PersistentVolumeClaim" });
  }
  async getPvc(name: string): Promise<KubePvc | undefined> {
    return (await this.get("persistentvolumeclaims", name)) as KubePvc | undefined;
  }
  deletePvc(name: string): Promise<void> {
    return this.remove("persistentvolumeclaims", name);
  }
  applySecret(secret: KubeSecret): Promise<void> {
    return this.apply("secrets", secret.metadata.name, { ...secret, apiVersion: "v1", kind: "Secret" });
  }
  deleteSecret(name: string): Promise<void> {
    return this.remove("secrets", name);
  }
  async listByLabel(selector: Record<string, string>): Promise<KubePod[]> {
    const query = Object.entries(selector)
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
    const body = await this.request("GET", `${this.pathFor("pods")}?labelSelector=${encodeURIComponent(query)}`);
    const list = body as { items?: KubePod[] };
    return list.items ?? [];
  }

  private pathFor(kind: ResourceKind, name?: string): string {
    const base = RESOURCES[kind].replace("{ns}", encodeURIComponent(this.namespace));
    return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
  }

  /**
   * Create-or-replace. POST first; on 409 read the object back for its resourceVersion and PUT.
   *
   * Server-side apply would avoid the read, at the cost of speaking `application/apply-patch+yaml`
   * and owning field-management semantics. The read is one request against a control plane that
   * creates objects rarely; the semantics are forever.
   */
  private async apply(kind: ResourceKind, name: string, manifest: Record<string, unknown>): Promise<void> {
    try {
      await this.request("POST", this.pathFor(kind), manifest);
    } catch (error) {
      if (!(error instanceof KubernetesError) || error.status !== 409) throw error;
      const existing = (await this.request("GET", this.pathFor(kind, name))) as {
        metadata?: { resourceVersion?: string };
      };
      const manifestMeta = (manifest.metadata ?? {}) as Record<string, unknown>;
      await this.request("PUT", this.pathFor(kind, name), {
        ...manifest,
        metadata: { ...manifestMeta, resourceVersion: existing.metadata?.resourceVersion },
      });
    }
  }

  private async get(kind: ResourceKind, name: string): Promise<unknown> {
    try {
      return await this.request("GET", this.pathFor(kind, name));
    } catch (error) {
      if (error instanceof KubernetesError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async remove(kind: ResourceKind, name: string): Promise<void> {
    try {
      await this.request("DELETE", this.pathFor(kind, name));
    } catch (error) {
      // Already gone is success: destroy after a half-finished create is a normal path.
      if (error instanceof KubernetesError && error.status === 404) return;
      throw error;
    }
  }

  private request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = new URL(`${this.credentials.server}${path}`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          method,
          hostname: url.hostname,
          port: url.port === "" ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          agent: this.agent,
          timeout: this.timeoutMs,
          headers: {
            accept: "application/json",
            ...(payload !== undefined ? { "content-type": "application/json" } : {}),
            ...(this.credentials.token !== undefined
              ? { authorization: `Bearer ${this.credentials.token}` }
              : {}),
          },
        },
        res => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode === undefined || res.statusCode >= 400) {
              // The server's Status body carries *why* (Forbidden vs NotFound vs conflict), which
              // is the difference between "fix RBAC" and "retry". Keep the reason in the error.
              let reason = text.slice(0, 200);
              try {
                const status = JSON.parse(text) as { message?: string };
                if (typeof status.message === "string") reason = status.message;
              } catch {
                // Not a Status body; the raw text is all there is.
              }
              reject(new KubernetesError(`${method} ${path} → ${res.statusCode}: ${reason}`, res.statusCode));
              return;
            }
            try {
              resolve(text === "" ? undefined : JSON.parse(text));
            } catch {
              reject(new KubernetesError(`${method} ${path}: the API server answered with non-JSON`));
            }
          });
        }
      );
      req.on("timeout", () => req.destroy(new KubernetesError(`${method} ${path}: timed out after ${this.timeoutMs}ms`)));
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}

/**
 * Pick credentials the way `kubectl` does: in-cluster first, kubeconfig second.
 *
 * The order matters and is the opposite of some clients': a control plane running in a cluster on
 * a laptop that also has a kubeconfig must use the ServiceAccount — that identity is the one the
 * deployment's RBAC was written for.
 */
export function kubeApiFromEnvironment(
  namespace: string,
  env: NodeJS.ProcessEnv = process.env
): HttpKubeApi {
  const credentials = inClusterCredentials(env) ?? kubeconfigCredentials(env);
  return new HttpKubeApi(credentials, namespace);
}
