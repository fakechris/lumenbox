/**
 * Where a box comes from.
 *
 * The orchestrator needs exactly two things about a box: a URL and a token. It does not
 * need to know that a box is a Docker container — and that assumption had spread anyway,
 * because the only way to learn the URL was to ask the Docker CLI for a published port.
 * So the turn loop and the web UI both imported the Docker manager to answer a question
 * that has nothing to do with Docker.
 *
 * This is the seam. A provisioner answers "where is the box, and what is the token", and
 * optionally owns its lifecycle. Docker is one implementation. Attaching to a box someone
 * else started is another, and is what makes the core runnable with no Docker at all.
 *
 * The one that matters later is Kubernetes: a box is a pod created by a broker, reached
 * through a Service, and its address is DNS rather than a published port. That
 * implementation belongs here as a third file and needs nothing from the rest of the
 * code — which is the point of doing this before we have a cluster to test against.
 */

import { assertCompatible, BoxClient } from "./client.ts";
import {
  BoxManager,
  defaultBoxConfig,
  type BoxConfig,
} from "./docker.ts";

export interface BoxEndpoint {
  /** As reachable from wherever the orchestrator runs. */
  baseUrl: string;
  token: string;
}

export interface BoxProvisioner {
  /** Which implementation this is, for logs and for tests. */
  readonly kind: "docker" | "attached" | "kubernetes";
  /** One line naming the box, for logs: the reader wants to know which box failed. */
  readonly label: string;
  /**
   * The box's identity, as opposed to its description. `label` is prose for a log line;
   * this is the key a box's record is stored under (its class, and later its owner), so
   * it has to be the same string next time this process starts.
   */
  readonly boxName: string;
  /** Where the box is, or undefined if there is not one running. Never throws. */
  endpoint(): Promise<BoxEndpoint | undefined>;
  /** A client for the box, provisioning it first if this implementation can. */
  connect(): Promise<BoxClient>;
  /**
   * Whether a newer image than the running one is on disk.
   *
   * Optional because only an implementation that owns the container's lifecycle can know.
   * A box somebody else runs is upgraded by whoever runs it, and guessing on their behalf
   * would be both wrong and unhelpful.
   */
  upgradeAvailable?(): Promise<{ available: boolean; running?: string; built?: string }>;
}

/**
 * A box someone else is running, named by URL.
 *
 * No lifecycle: it cannot start or stop anything, which is exactly right when the thing
 * on the other end is a pod, a box on another machine, or a container started by compose.
 */
export class AttachedBoxProvisioner implements BoxProvisioner {
  readonly kind = "attached" as const;
  readonly label: string;
  readonly boxName: string;
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: { baseUrl: string; token?: string }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    // The explicit token, or the environment's — and deliberately *not* a local box's.
    //
    // This used to fall through to `readBoxToken()`, which resolves the local default
    // box's key. Attaching is by definition talking to a box this process does not run,
    // so that key is both wrong for the endpoint and ours to protect: it was sent, in
    // full, to whatever URL somebody typed. Minting is likewise refused — a token this
    // process invented cannot match the box's — so the honest outcome when neither is
    // configured is to fail and say which variable to set.
    const token = options.token ?? process.env.AGENTBOX_TOKEN;
    if (!token) {
      throw new Error(
        `No box token for ${this.baseUrl}. Set AGENTBOX_TOKEN to the token the box was ` +
          "started with — a token cannot be invented for a box someone else is running, " +
          "and this machine's own box key is not it."
      );
    }
    this.token = token;
    this.label = `attached (${this.baseUrl})`;
    // The URL is the only durable name we have for a box we did not start.
    this.boxName = this.baseUrl;
  }

  async endpoint(): Promise<BoxEndpoint> {
    return { baseUrl: this.baseUrl, token: this.token };
  }

  async connect(): Promise<BoxClient> {
    const client = new BoxClient({ baseUrl: this.baseUrl, token: this.token });
    // Checked here rather than on first use: "the box is unreachable" is a much better
    // failure than a tool call that mysteriously times out mid-turn.
    assertCompatible(await client.health(), this.baseUrl);
    return client;
  }
}

/** A box this process runs as a local (or DOCKER_HOST-reachable) container. */
export class DockerBoxProvisioner implements BoxProvisioner {
  readonly kind = "docker" as const;
  readonly label: string;
  readonly boxName: string;
  private readonly manager: BoxManager;

  constructor(config: BoxConfig = defaultBoxConfig()) {
    this.manager = new BoxManager(config);
    this.label = `docker (${config.containerName})`;
    this.boxName = config.containerName;
  }

  async endpoint(): Promise<BoxEndpoint | undefined> {
    try {
      const status = await this.manager.status();
      if (!status.boxdUrl) return undefined;
      return { baseUrl: status.boxdUrl, token: this.manager.config.token };
    } catch {
      // No Docker, no container, no engine: all of them mean "no endpoint", and the
      // caller's job is to say so once rather than to distinguish them here.
      return undefined;
    }
  }

  async connect(): Promise<BoxClient> {
    const client = await this.manager.connect();
    assertCompatible(await client.health(), this.label);
    return client;
  }

  upgradeAvailable(): Promise<{ available: boolean; running?: string; built?: string }> {
    return this.manager.upgradeAvailable();
  }
}

/**
 * Which box this process should talk to.
 *
 * AGENTBOX_BOXD_URL wins, because naming a box explicitly is how every deployment that
 * is not a developer's laptop will do it. Docker is the fallback and the default.
 */
export function resolveBoxProvisioner(): BoxProvisioner {
  const url = process.env.AGENTBOX_BOXD_URL?.trim();
  if (url) return new AttachedBoxProvisioner({ baseUrl: url });
  return new DockerBoxProvisioner();
}
