/**
 * Pre-pulls an image onto every schedulable node, so a rollout scheduled afterwards starts in
 * seconds instead of pulling 800MB while the Deployment's old replica is already gone.
 *
 * The mechanism is deliberately dumb: one throwaway pod per node, pinned by nodeSelector,
 * running `/bin/sh -c true`. Kubernetes pulls the image before the container may start, so a
 * pod reaching Succeeded is exactly "this node has the image". No daemonset, no tolerations
 * dance — a node that cannot run the pod is a node the rollout will surface on its own.
 *
 * Why this exists: the box image is ~800MB and a cold node pull is the dominant cost of a
 * deploy (measured: minutes on a healthy node, much longer on a sick one). The control plane's
 * Deployment uses the Recreate strategy — its store is a SQLite file that tolerates no second
 * writer — so pulling *before* rolling is the difference between seconds of downtime and a
 * control plane that is down for the whole pull.
 *
 * Run:
 *   node --experimental-transform-types scripts/k8s-prewarm.ts --image <registry>/<repo>:<tag>
 *
 * Options: --namespace <ns> (default agentbox), --timeout <minutes> (default 45).
 * Then roll: kubectl -n agentbox set image deploy/agentbox-control control=<same tag>.
 */

import { kubeApiFromEnvironment } from "../src/control/kube-client.ts";

interface Args {
  namespace: string;
  image?: string;
  timeoutMinutes: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { namespace: "agentbox", timeoutMinutes: 45 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--namespace") args.namespace = argv[++i] ?? args.namespace;
    else if (argv[i] === "--image") args.image = argv[++i];
    else if (argv[i] === "--timeout") args.timeoutMinutes = Number(argv[++i] ?? args.timeoutMinutes);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (args.image === undefined) throw new Error("--image is required (the exact tag the rollout will use)");
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const api = kubeApiFromEnvironment(args.namespace);

  const nodes = (await api.listNodes()).filter(node => node.schedulable);
  if (nodes.length === 0) throw new Error("no schedulable nodes");
  console.log(`prewarm: ${args.image} onto ${nodes.length} node(s): ${nodes.map(n => n.name).join(", ")}`);

  const labels = { "app.kubernetes.io/managed-by": "agentbox-prewarm" };
  const startedAt = Date.now();
  const podName = (node: string) => `agentbox-prewarm-${node}`;

  const cleanup = async (): Promise<void> => {
    for (const node of nodes) await api.deletePod(podName(node.name)).catch(() => {});
  };

  try {
    for (const node of nodes) {
      await api.applyPod({
        metadata: { name: podName(node.name), labels },
        spec: {
          restartPolicy: "Never",
          nodeSelector: { "kubernetes.io/hostname": node.name },
          containers: [{ name: "pull", image: args.image, command: ["/bin/sh", "-c", "true"] }],
        },
      });
    }

    const deadline = Date.now() + args.timeoutMinutes * 60_000;
    const pending = new Map(nodes.map(node => [node.name, startedAt] as const));
    let failed = 0;
    while (pending.size > 0 && Date.now() < deadline) {
      for (const [node] of [...pending]) {
        const pod = await api.getPod(podName(node));
        const phase = pod?.status?.phase;
        if (phase === "Succeeded") {
          const seconds = Math.round((Date.now() - startedAt) / 1000);
          console.log(`  ${node}: image present (${seconds}s)`);
          pending.delete(node);
        } else if (phase === "Failed") {
          console.log(`  ${node}: FAILED — pod ran but exited nonzero; the image pulled, treating as warm`);
          pending.delete(node);
        } else {
          // Still pulling (or Pending). Two waiters must not look alike: a pod the scheduler
          // cannot place (PodScheduled=False — node cordoned, pod limit hit) will never pull,
          // and a node in that state cannot take a rollout either, so warn and move on rather
          // than fail. The waiting reason names a hard pull failure (ErrImagePull) early
          // instead of after the full timeout.
          const scheduled = pod?.status?.conditions?.find(c => c.type === "PodScheduled");
          if (scheduled !== undefined && scheduled.status === "False") {
            console.log(`  ${node}: UNSCHEDULABLE (skipped) — this node could not take a box today either`);
            pending.delete(node);
            continue;
          }
          const waiting = pod?.status?.containerStatuses?.[0]?.state?.waiting?.reason;
          if (waiting === "ErrImagePull" || waiting === "ImagePullBackOff") {
            console.log(`  ${node}: FAILED — ${waiting}`);
            pending.delete(node);
            failed++;
          }
        }
      }
      if (pending.size > 0) await new Promise(resolve => setTimeout(resolve, 5_000));
    }
    for (const [node] of pending) {
      console.log(`  ${node}: TIMED OUT after ${args.timeoutMinutes}m — the pull may still finish; re-run to check`);
      failed++;
    }

    await cleanup();
    if (failed > 0) {
      console.log(`prewarm: ${failed} node(s) not warm — rolling now would stall on them`);
      process.exit(1);
    }
    console.log(`prewarm: OK — every node has the image; roll the deployment now`);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

await main();
