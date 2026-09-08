/**
 * Wire-level smoke test for the kubernetes allocator's client, against a real cluster.
 *
 * The unit suite holds the allocator to a fake KubeApi; this script holds the real HttpKubeApi to
 * a real apiserver. It exists because the fake cannot see the things a cluster does on its own:
 * server-assigned fields (a Service's clusterIP), asynchronous deletion, DeleteOptions shapes an
 * old apiserver may reject, and auth that worked in a test and 401s in production.
 *
 * What it exercises, in order:
 *
 *   1. credential loading (server and auth mode are printed; the token never is)
 *   2. applySecret twice — the second apply exercises the 409 → GET → merge → PUT path
 *   3. applyService twice — the second apply must preserve the assigned clusterIP (the bug class
 *      that bricked tenants before apply became kind-aware)
 *   4. applyPvc + getPvc + deletePvc (binding is not awaited — a local provisioner binds on first
 *      consumer, which is out of scope here)
 *   5. applyPod, polled to Running
 *   6. applyPod again — the replace path: grace-0 delete, wait for the name to free, re-POST
 *   7. delete of every object, with getPod confirming the pod is gone
 *
 * What it does NOT test: the box image and the allocator end to end. That needs the box image in
 * a registry the cluster can pull from (see deploy/kubernetes/ONBOARDING.md); this script exists
 * precisely so the wire can be validated before that pipeline exists.
 *
 * Everything it creates is named `agentbox-smoke-<random>` and labeled
 * `app.kubernetes.io/managed-by: agentbox-smoke`, and cleanup runs on failure too.
 *
 * Run:
 *   node --experimental-transform-types scripts/k8s-smoke.ts [--namespace default] [--image nginx:alpine]
 *
 * The image must be pullable by the cluster's nodes — an image already in use on the cluster is
 * the safest choice. The namespace must exist and the credentials must be allowed to manage pods,
 * services, PVCs and secrets in it.
 */

import { randomBytes } from "node:crypto";
import { kubeApiFromEnvironment } from "../src/control/kube-client.ts";

interface Args {
  namespace: string;
  image: string;
  keep: boolean;
  node?: string;
  /** Comma-joined container args, for images whose entrypoint needs them (e.g. consul agent -dev). */
  containerArgs?: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { namespace: "default", image: "nginx:alpine", keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--namespace") args.namespace = argv[++i] ?? args.namespace;
    else if (argv[i] === "--image") args.image = argv[++i] ?? args.image;
    else if (argv[i] === "--keep") args.keep = true;
    else if (argv[i] === "--node") args.node = argv[++i];
    else if (argv[i] === "--args") args.containerArgs = (argv[++i] ?? "").split(",");
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

let failures = 0;
function step(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const suffix = randomBytes(3).toString("hex");
  const name = `agentbox-smoke-${suffix}`;
  const labels = { "app.kubernetes.io/managed-by": "agentbox-smoke" };

  console.log(`smoke: namespace=${args.namespace} name=${name} image=${args.image}`);

  const api = kubeApiFromEnvironment(args.namespace);
  step(true, "credentials loaded");

  const secret = {
    metadata: { name, labels },
    data: { BOXD_TOKEN: Buffer.from(`token-${suffix}`).toString("base64") },
  };
  const service = {
    metadata: { name, labels },
    spec: {
      selector: { "app.kubernetes.io/instance": name },
      ports: [{ name: "boxd", port: 1337, targetPort: 80 }],
    },
  };
  const pvc = {
    metadata: { name: `${name}-work`, labels },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "64Mi" } },
    },
  };
  const pod = {
    metadata: { name, labels: { ...labels, "app.kubernetes.io/instance": name } },
    spec: {
      restartPolicy: "Never",
      // --node pins the pod where the image is cached — clusters whose nodes cannot reach a
      // public registry can only run what they already have.
      ...(args.node !== undefined
        ? { nodeSelector: { "kubernetes.io/hostname": args.node } }
        : {}),
      containers: [
        {
          name: "probe",
          image: args.image,
          ports: [{ containerPort: 80 }],
          ...(args.containerArgs !== undefined ? { args: args.containerArgs } : {}),
        },
      ],
    },
  };

  const cleanup = async (): Promise<void> => {
    if (args.keep) {
      console.log(`smoke: --keep set, leaving ${name} behind`);
      return;
    }
    // Every delete tolerates absence; cleanup after a half-finished run is the normal case.
    await api.deletePod(name).catch(() => {});
    await api.deleteService(name).catch(() => {});
    await api.deleteSecret(name).catch(() => {});
    await api.deletePvc(`${name}-work`).catch(() => {});
  };

  try {
    await api.applySecret(secret);
    await api.applySecret({
      ...secret,
      data: { BOXD_TOKEN: Buffer.from(`rotated-${suffix}`).toString("base64") },
    });
    step(true, "secret apply is idempotent (409 → merge → PUT)");

    await api.applyService(service);
    const afterFirst = await api.getService(name);
    await api.applyService(service);
    const afterSecond = (await api.getService(name)) as
      | { spec?: { clusterIP?: string } }
      | undefined;
    const firstIp = (afterFirst as { spec?: { clusterIP?: string } } | undefined)?.spec?.clusterIP;
    step(
      afterSecond !== undefined && firstIp !== undefined && afterSecond.spec?.clusterIP === firstIp,
      "service re-apply preserves the assigned clusterIP",
      firstIp
    );

    await api.applyPvc(pvc);
    step((await api.getPvc(`${name}-work`)) !== undefined, "pvc apply + get");
    await api.deletePvc(`${name}-work`);
    // Deletion is asynchronous (the pvc-protection finalizer holds the object briefly even when
    // nothing consumes it), so a GET issued immediately after the DELETE still finds it.
    let pvcGone = false;
    for (let i = 0; i < 15 && !pvcGone; i++) {
      pvcGone = (await api.getPvc(`${name}-work`)) === undefined;
      if (!pvcGone) await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    step(pvcGone, "pvc delete");
    await api.applyPvc(pvc); // leave one behind so cleanup has something to remove

    await api.applyPod(pod);
    const deadline = Date.now() + 90_000;
    let phase: string | undefined;
    while (Date.now() < deadline) {
      phase = (await api.getPod(name))?.status?.phase;
      if (phase === "Running" || phase === "Succeeded") break;
      if (phase === "Failed") break;
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    step(phase === "Running" || phase === "Succeeded", "pod reaches Running", phase);

    // The replace path: same name applied twice. Internally this is grace-0 delete, wait for the
    // name to free, re-POST — the sequence a 1.16 apiserver is least likely to take quietly.
    await api.applyPod(pod);
    step(true, "pod re-apply (delete + wait + re-POST)");

    await cleanup();
    // A running pod is deleted with the default 30s grace — "deleted" is accepted, not done.
    let podGone = false;
    for (let i = 0; i < 25 && !podGone; i++) {
      podGone = (await api.getPod(name)) === undefined;
      if (!podGone) await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    step(podGone, "cleanup removed the pod");
  } catch (error) {
    step(false, "smoke aborted", error instanceof Error ? error.message : String(error));
    await cleanup();
  }

  console.log(failures === 0 ? "smoke: OK" : `smoke: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
