/**
 * An organisation installation's boxes on a real cluster (INV-1692): the five steps, end to end.
 *
 * The unit suite (src/box/kubernetes-box.test.ts) holds the per-box driver to a fake API server;
 * this holds the same code — `PersonalBoxes` over `KubernetesBoxDriver` over the control plane's
 * `KubeBoxes` and the real `HttpKubeApi` — to a cluster:
 *
 *   1. two boxes are created, for two members;
 *   2. each has its own pod, Service, three PVCs, Secret and NetworkPolicy;
 *   3. they cannot reach each other — from inside box A, box B's boxd does not answer — while a
 *      pod labelled `agentbox/role=control` (where the server runs) reaches both, and each box
 *      accepts only its own token;
 *   4. the server restarts with a box's pod gone (deleted while it was down): a new instance over
 *      the same state recreates it on its volume — a file written before is still there — with
 *      the token it already held;
 *   5. both boxes are deleted with their data, and nothing labelled by agentbox is left.
 *
 * Tokens never reach the output: they travel to curl on stdin, and only status codes print.
 * Everything lives in one namespace the script creates and deletes (also on failure).
 *
 * Run (a kind cluster with the box image loaded: `kind load docker-image <image> --name <c>`):
 *   node --experimental-transform-types scripts/k8s-org-boxes.ts \
 *     --kubeconfig /tmp/kubeconfig --context kind-lumenbox-inv-1692 --image fakechris/lumenbox:0.3.28
 *
 * The kubeconfig's current-context must be the one named: the API client reads current-context,
 * kubectl gets `--context`, and refusing a mismatch is how this never touches another cluster.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxEntry } from "../src/box/boxes.ts";
import { KubernetesBoxDriver } from "../src/box/kubernetes-box.ts";
import { KubeBoxes } from "../src/control/kube-box.ts";
import { kubeApiFromEnvironment } from "../src/control/kube-client.ts";
import { staticDecision } from "../src/control/policy.ts";
import { PersonalBoxes } from "../src/host/personal-boxes.ts";

function parseArgs(argv: string[]) {
  const args = { kubeconfig: "", context: "", namespace: "lumenbox-org-verify", image: "fakechris/lumenbox:0.3.28", memory: "2Gi", keep: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--kubeconfig") args.kubeconfig = argv[++i] ?? "";
    else if (flag === "--context") args.context = argv[++i] ?? "";
    else if (flag === "--namespace") args.namespace = argv[++i] ?? args.namespace;
    else if (flag === "--image") args.image = argv[++i] ?? args.image;
    else if (flag === "--memory") args.memory = argv[++i] ?? args.memory;
    else if (flag === "--keep") args.keep = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (args.kubeconfig === "" || args.context === "") throw new Error("--kubeconfig and --context are required");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const current = /^current-context:\s*(\S+)/m.exec(readFileSync(args.kubeconfig, "utf8"))?.[1];
if (current !== args.context) throw new Error(`${args.kubeconfig} has current-context ${current}, not ${args.context}; refusing`);
process.env.KUBECONFIG = args.kubeconfig;

function kubectl(command: string[], input?: string): string {
  return execFileSync("kubectl", ["--kubeconfig", args.kubeconfig, "--context", args.context, ...command], {
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 180_000,
  });
}
function show(title: string, command: string[]): void {
  console.log(`\n$ kubectl -n ${args.namespace} ${command.join(" ")}   # ${title}`);
  console.log(kubectl(["-n", args.namespace, ...command]).trimEnd());
}
function check(ok: boolean, what: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) process.exitCode = 1;
}
/** curl from inside a pod; the token, when there is one, arrives on stdin and never in argv. */
function curlFrom(pod: string, url: string, token?: string): string {
  const script = token === undefined
    ? `curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${url} || true`
    : `read -r T; curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{}' ${url} || true`;
  return kubectl(["-n", args.namespace, "exec", "-i", pod, "--", "sh", "-c", script], token === undefined ? "" : `${token}\n`).trim();
}

const SELECTOR = "app.kubernetes.io/managed-by=agentbox";
const PROBE = "org-server-probe";
const home = mkdtempSync(join(tmpdir(), "k8s-org-boxes-"));
const entries: BoxEntry[] = [];

/** One "server process": its own API client, driver and PersonalBoxes over the shared state dir. */
function server(): PersonalBoxes {
  const boxes = new KubeBoxes({
    api: kubeApiFromEnvironment(args.namespace),
    namespace: args.namespace,
    defaultImage: () => args.image,
    imagePullPolicy: "IfNotPresent",
    fixedEnv: { DISPLAY_WIDTH: "1280", DISPLAY_HEIGHT: "800" },
    onOutput: line => console.log(`  [kube] ${line}`),
  });
  const driver = new KubernetesBoxDriver({ boxes, image: args.image, decision: staticDecision({ memory: args.memory, storage: "1Gi" }) });
  return new PersonalBoxes({
    home, entries: () => entries, quota: () => undefined, authorize: () => true,
    attach: entry => { const at = entries.findIndex(e => e.id === entry.id); if (at >= 0) entries[at] = entry; else entries.push(entry); },
    detach: id => { entries.splice(entries.findIndex(e => e.id === id), 1); },
    residents: () => 0, driver,
  });
}

async function main(): Promise<void> {
  console.log(`cluster: ${args.context}   namespace: ${args.namespace}   image: ${args.image}`);
  console.log(kubectl(["version"]).trimEnd());
  kubectl(["create", "namespace", args.namespace]);
  // Where the server runs, for this probe: a pod with the one label a box's policy admits.
  kubectl(["-n", args.namespace, "run", PROBE, "--image", args.image, "--image-pull-policy", "IfNotPresent",
    "--labels", "agentbox/role=control", "--command", "--", "sleep", "infinity"]);
  kubectl(["-n", args.namespace, "wait", "--for=condition=Ready", `pod/${PROBE}`, "--timeout=180s"]);

  console.log("\n== 1. create two boxes (alice's, bob's) ==");
  const first = server();
  const started = Date.now();
  const [a, b] = await Promise.all([first.create("alice", "verify-1"), first.create("bob", "verify-1")]);
  console.log(`alice: ${a.name} ${a.status}${a.stateReason ? ` (${a.stateReason}: ${a.stateMessage})` : ""}`);
  console.log(`bob:   ${b.name} ${b.status}${b.stateReason ? ` (${b.stateReason}: ${b.stateMessage})` : ""}`);
  console.log(`both ready in ${Math.round((Date.now() - started) / 1000)}s`);
  check(a.status === "ready" && b.status === "ready", "both boxes are ready");
  if (a.status !== "ready" || b.status !== "ready") return;

  console.log("\n== 2. one pod per box, each with its own objects ==");
  show("pods", ["get", "pods", "-l", SELECTOR, "-o", "wide", "-L", "agentbox/box,agentbox/owner"]);
  show("services, policies, secrets", ["get", "svc,networkpolicy,secret", "-l", SELECTOR]);
  show("volumes", ["get", "pvc", "-l", SELECTOR]);
  const pods = kubectl(["-n", args.namespace, "get", "pods", "-l", SELECTOR, "-o", "name"]).trim().split("\n");
  check(pods.length === 2 && pods.includes(`pod/${a.name}`) && pods.includes(`pod/${b.name}`), "exactly two pods, one per box");
  const tokenA = readFileSync(a.tokenFile, "utf8").trim();
  const tokenB = readFileSync(b.tokenFile, "utf8").trim();
  const describe = kubectl(["-n", args.namespace, "get", "pod", a.name, b.name, "-o", "json"]);
  check(!describe.includes(tokenA) && !describe.includes(tokenB), "no token appears in either pod spec");

  console.log("\n== 3. isolation ==");
  const url = (name: string, path: string) => `http://${name}.${args.namespace}.svc:1337${path}`;
  const serverToA = curlFrom(PROBE, url(a.name, "/health"));
  const serverToB = curlFrom(PROBE, url(b.name, "/health"));
  console.log(`server -> A /health: ${serverToA}   server -> B /health: ${serverToB}`);
  check(serverToA === "200" && serverToB === "200", "the server (agentbox/role=control) reaches both boxes");
  const own = curlFrom(PROBE, url(a.name, "/jobs"), tokenA);
  const crossed = curlFrom(PROBE, url(a.name, "/jobs"), tokenB);
  console.log(`A /jobs with A's token: ${own}   A /jobs with B's token: ${crossed}`);
  check(own === "200" && crossed === "401", "each box accepts its own token and refuses the other's");
  const aToB = curlFrom(a.name, url(b.name, "/health"));
  const bToA = curlFrom(b.name, url(a.name, "/health"));
  console.log(`A -> B /health: ${aToB}   B -> A /health: ${bToA}   (000 = no answer within 5s)`);
  check(aToB === "000" && bToA === "000", "neither box reaches the other");
  // The control: the same probe with B's policy lifted answers, so the 000 above is the policy's
  // doing and not a box that cannot resolve or curl. The policy is put back as it was.
  const policy = JSON.parse(kubectl(["-n", args.namespace, "get", "networkpolicy", b.name, "-o", "json"])) as { metadata: Record<string, unknown> };
  for (const field of ["resourceVersion", "uid", "creationTimestamp", "generation", "managedFields"]) delete policy.metadata[field];
  kubectl(["-n", args.namespace, "delete", "networkpolicy", b.name]);
  await new Promise(resolve => setTimeout(resolve, 3000));
  const unguarded = curlFrom(a.name, url(b.name, "/health"));
  kubectl(["-n", args.namespace, "create", "-f", "-"], JSON.stringify(policy));
  await new Promise(resolve => setTimeout(resolve, 3000));
  const guardedAgain = curlFrom(a.name, url(b.name, "/health"));
  console.log(`control: A -> B with B's policy lifted: ${unguarded}; restored: ${guardedAgain}`);
  check(unguarded === "200" && guardedAgain === "000", "the refusal is B's NetworkPolicy (lifted it answers, restored it does not)");

  console.log("\n== 4. the server restarts; box A's pod was deleted while it was down ==");
  kubectl(["-n", args.namespace, "exec", a.name, "--", "sh", "-c", "echo kept-across-restart > /home/box/work/marker.txt"]);
  const oldUid = kubectl(["-n", args.namespace, "get", "pod", a.name, "-o", "jsonpath={.metadata.uid}"]);
  kubectl(["-n", args.namespace, "delete", "pod", a.name, "--wait=true"]);
  show("after the delete", ["get", "pods", "-l", SELECTOR]);
  const restarted = server(); // a new process's view: same state directory, fresh clients
  await restarted.recover(line => console.log(`  [server] ${line}`));
  show("after recovery", ["get", "pods", "-l", SELECTOR, "-o", "wide"]);
  const newUid = kubectl(["-n", args.namespace, "get", "pod", a.name, "-o", "jsonpath={.metadata.uid}"]);
  const marker = kubectl(["-n", args.namespace, "exec", a.name, "--", "cat", "/home/box/work/marker.txt"]).trim();
  const afterToken = curlFrom(PROBE, url(a.name, "/jobs"), tokenA);
  console.log(`pod uid ${oldUid} -> ${newUid}; marker: ${marker}; A /jobs with its stored token: ${afterToken}`);
  check(newUid !== "" && newUid !== oldUid && marker === "kept-across-restart" && afterToken === "200",
    "box A came back as a new pod on its own volume, with the token the server held");
  check(restarted.list("alice")[0]?.status === "ready" && restarted.list("bob")[0]?.status === "ready", "both records still ready");

  console.log("\n== 5. delete both boxes with their data ==");
  await restarted.remove("alice", a.id, true);
  await restarted.remove("bob", b.id, true);
  for (let i = 0; i < 30; i++) {
    if (kubectl(["-n", args.namespace, "get", "pods,svc,pvc,secret,networkpolicy", "-l", SELECTOR, "-o", "name"]).trim() === "") break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  show("everything agentbox labelled", ["get", "pods,svc,pvc,secret,networkpolicy", "-l", SELECTOR]);
  const left = kubectl(["-n", args.namespace, "get", "pods,svc,pvc,secret,networkpolicy", "-l", SELECTOR, "-o", "name"]).trim();
  check(left === "", "nothing is left");
  const boundHere = () => kubectl(["get", "pv", "-o", "jsonpath={range .items[*]}{.spec.claimRef.namespace}{\"\\n\"}{end}"]).split("\n").filter(ns => ns === args.namespace);
  // The provisioner deletes a released volume on its own schedule; give it a minute.
  for (let i = 0; i < 30 && boundHere().length > 0; i++) await new Promise(resolve => setTimeout(resolve, 2000));
  const volumes = boundHere();
  console.log(`persistent volumes still bound to ${args.namespace}: ${volumes.length}`);
  check(volumes.length === 0, "the volumes behind the claims were reclaimed");
  check(restarted.list("alice").length === 0 && restarted.list("bob").length === 0, "the records are deleted");
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  if (!args.keep) {
    console.log(`\n$ kubectl delete namespace ${args.namespace}`);
    try {
      console.log(kubectl(["delete", "namespace", args.namespace, "--wait=true"]).trimEnd());
    } catch (error) {
      console.error(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  rmSync(home, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
console.log(process.exitCode === 1 ? "\nRESULT: FAIL" : "\nRESULT: PASS");
// Keep-alive sockets to the apiserver would hold the process open.
process.exit(process.exitCode ?? 0);
