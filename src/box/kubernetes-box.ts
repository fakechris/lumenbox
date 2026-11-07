/**
 * An organisation installation's boxes as pods (INV-1692, docs/36 Scene 4).
 *
 * A server installation provisions boxes one at a time — today the personal boxes members take
 * within quota — through the `PersonalBoxDriver` seam that `PersonalDocker` also fills. This is the
 * Kubernetes filling, keyed per *box*: one box record, one pod, its own three volumes, its own
 * Secret with its own token, its own NetworkPolicy. It reuses the control plane's `KubeBoxes` for
 * everything a box is in a cluster; the only thing decided here is the key and the labels.
 *
 * Membership is not decided here either: the box entry the installation attaches carries
 * `members`, and the registry's membership is the authority (docs/22 inner door). A pod's labels
 * name its box and owner by hash, for an operator's kubectl, never for access.
 *
 * The orchestrator reaches a box at its Service DNS, so a server using this backend runs in the
 * cluster, in a pod labelled `agentbox/role=control` — the one label a box's policy admits.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { boxBackendFromEnvironment } from "../config.ts";
import { BoxStartError, KubeBoxes, type KubeBoxPlacement } from "../control/kube-box.ts";
import { kubeApiFromEnvironment, type KubeApi } from "../control/kube-client.ts";
import { DEFAULT_NAMESPACE } from "../control/kubernetes.ts";
import { type AllocationDecision, staticDecision } from "../control/policy.ts";
import type { PersonalBoxDriver, PersonalBoxRecord, RecoveredBox } from "../host/personal-boxes.ts";
import { defaultBoxImage } from "./docker.ts";
import { PersonalDocker } from "./personal.ts";

const BOX_LABEL = "agentbox/box";
const OWNER_LABEL = "agentbox/owner";

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export interface KubernetesBoxDriverOptions {
  boxes: KubeBoxes;
  /** Pinned: the image a box is created with is the image it is recovered with. */
  image: string;
  decision: AllocationDecision;
}

export class KubernetesBoxDriver implements PersonalBoxDriver {
  constructor(private readonly options: KubernetesBoxDriverOptions) {}

  /** One box record, one placement. The pod's name is the record's name — the container's under Docker. */
  placement(record: PersonalBoxRecord, token = readFileSync(record.tokenFile, "utf8").trim()): KubeBoxPlacement {
    return {
      name: record.name,
      owner: { [BOX_LABEL]: shortHash(record.id), [OWNER_LABEL]: shortHash(record.owner) },
      spec: { image: this.options.image },
      tokens: { box: token },
      decision: this.options.decision,
    };
  }

  async start(record: PersonalBoxRecord): Promise<string> {
    return (await this.options.boxes.create(this.placement(record))).boxdUrl;
  }

  /** Keep the data: pod and Service go, volumes and Secret stay. Delete it: everything goes. */
  async remove(record: PersonalBoxRecord, deleteData: boolean): Promise<void> {
    if (deleteData) await this.options.boxes.destroy(record.name);
    else await this.options.boxes.stop(record.name);
  }

  /**
   * After a server restart: a ready box whose pod is missing (node lost, evicted, deleted while
   * the server was down) is recreated from its stored token onto its surviving volumes. A pod
   * launched from another configuration is reported as drifted, never rebuilt on its own — that
   * is a person's decision (INV-712).
   */
  async recover(record: PersonalBoxRecord): Promise<RecoveredBox> {
    const placement = this.placement(record);
    const found = await this.options.boxes.locate(record.name);
    if (found === undefined) return { state: "gone", drifted: false, reason: "Gone" };
    const drifted = found.digest !== undefined && found.digest !== this.options.boxes.digestOf(placement);
    if (found.running) return { state: "running", drifted, endpoint: found.boxdUrl };
    try {
      await this.options.boxes.restart(placement);
    } catch (error) {
      return { state: "failed", drifted, reason: error instanceof BoxStartError ? error.reason : "RestartFailed" };
    }
    return { state: "restarted", drifted: false, endpoint: found.boxdUrl };
  }
}

/**
 * The driver a server's provisioned boxes use. The desktop installation is the owner's own
 * machine and its boxes are its own Docker's — never a cluster (route B, INV-1687).
 */
export function provisionedBoxDriver(desktop: boolean, inject: { api?: KubeApi; env?: NodeJS.ProcessEnv } = {}): PersonalBoxDriver {
  const settings = boxBackendFromEnvironment(inject.env);
  if (settings.backend === "docker") return new PersonalDocker();
  if (desktop) throw new Error("AGENTBOX_BOX_BACKEND=kubernetes is for a server installation; the desktop app's boxes run on this machine's Docker.");
  const namespace = settings.namespace ?? DEFAULT_NAMESPACE;
  const image = defaultBoxImage();
  const boxes = new KubeBoxes({
    api: inject.api ?? kubeApiFromEnvironment(namespace),
    namespace,
    defaultImage: () => image,
    ...(settings.storageClassName !== undefined ? { storageClassName: settings.storageClassName } : {}),
    ...(settings.imagePullPolicy !== undefined ? { imagePullPolicy: settings.imagePullPolicy } : {}),
    // What PersonalDocker gives the same box: a desktop of this size, boxd only — the orchestrator
    // is this server, outside the box.
    fixedEnv: { DISPLAY_WIDTH: "1280", DISPLAY_HEIGHT: "800" },
  });
  return new KubernetesBoxDriver({
    boxes,
    image,
    decision: staticDecision({ ...(settings.memory ? { memory: settings.memory } : {}), ...(settings.storage ? { storage: settings.storage } : {}) }),
  });
}
