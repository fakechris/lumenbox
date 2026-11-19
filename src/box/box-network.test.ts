/**
 * Tests for whether the relay is a box's only way out (INV-816).
 *
 * What can be pinned without an engine: when a box is to be confined, that a confined box is
 * handed no route and no publication of its own, that the gate carries exactly the listed
 * ports — its program is run here for real — and that the startup line reports what the engine
 * has rather than what was asked. Whether a packet actually leaves is the engine's answer, and
 * `scripts/egress-confinement-check.mjs` asks it in a real box.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, connect, type AddressInfo } from "node:net";
import { once } from "node:events";
import {
  GATE_SCRIPT,
  boxNetworkArguments,
  describeOutbound,
  gateForwards,
  gateNameFor,
  gateNetworkNameFor,
  gateRunArguments,
  networkNameFor,
  outboundPlan,
  prepareBoxNetwork,
  type DockerRunner,
  type OutboundPlan,
} from "./box-network.ts";

const RELAY = { AGENTBOX_EGRESS_RELAY: "host.docker.internal:8790", AGENTBOX_EGRESS_TOKEN: "relay-token-for-tests" };
const valueAfter = (args: string[], flag: string) => args.flatMap((argument, index) => (argument === flag ? [args[index + 1]!] : []));

test("a box is confined when a relay is named and the orchestrator is outside it — and only then", () => {
  const confined = outboundPlan({}, { ...RELAY, AGENTBOX_PORT: "7788" });
  assert.equal(confined.confined, true);
  // The web port is the one other door: the MCP face and the model relay are behind it.
  assert.deepEqual(confined.confined && [confined.relayPort, [...confined.hostPorts]], [8790, [7788]]);

  // Nothing to be confined to.
  assert.deepEqual(outboundPlan({}, {}), { confined: false, why: "no-relay" });
  // A member's box is never handed the installation's relay, so it is not confined to it either.
  assert.deepEqual(outboundPlan({ isolated: true }, RELAY), { confined: false, why: "no-relay" });
  // An orchestrator inside the box calls its model from there; cutting its route would stop it.
  assert.equal((outboundPlan({ withHost: true }, RELAY) as { why: string }).why, "self-contained");
  // The written opt-out, which the startup line then repeats at every start.
  assert.equal((outboundPlan({}, { ...RELAY, AGENTBOX_EGRESS_ENFORCE: "off" }) as { why: string }).why, "opted-out");
  // A relay address the gate could not forward to must not quietly become "not confined".
  assert.throws(() => outboundPlan({}, { AGENTBOX_EGRESS_RELAY: "relay-without-a-port" }), /host:port/);
});

test("a confined box is given no publication and no name for the host but the gate's", () => {
  const plan = outboundPlan({}, RELAY);
  const args = boxNetworkArguments("box-a", plan, "127.0.0.1::1337");
  // An internal network publishes nothing; a `--publish` here would be a claim the engine ignores.
  assert.deepEqual(valueAfter(args, "--publish"), []);
  // `--add-host host.docker.internal:host-gateway` would shadow the gate's alias with an address the box cannot reach.
  assert.deepEqual(valueAfter(args, "--add-host"), []);
  assert.deepEqual(valueAfter(args, "--network"), [networkNameFor("box-a")]);
  assert.ok(valueAfter(args, "--env").includes("AGENTBOX_EGRESS_RELAY=host.docker.internal:8790"));

  // The gate carries the publication instead, and forwards the daemon in and only the relay and the web port out.
  const gate = gateRunArguments({ containerName: "box-a", image: "image:1", publish: "127.0.0.1::1337", plan: plan as Extract<OutboundPlan, { confined: true }> });
  assert.deepEqual(valueAfter(gate, "--publish"), ["127.0.0.1::1337"]);
  assert.deepEqual(valueAfter(gate, "--network"), [gateNetworkNameFor("box-a")]);
  assert.deepEqual(gateForwards("box-a", plan as Extract<OutboundPlan, { confined: true }>).split(","), [
    "1337=box-a:1337",
    "8790=host.docker.internal:8790",
    "7777=host.docker.internal:7777",
  ]);
  // It is a pipe, not a router and not a place to stand.
  assert.deepEqual(valueAfter(gate, "--cap-drop"), ["ALL"]);
  assert.deepEqual(valueAfter(gate, "--sysctl"), ["net.ipv4.ip_forward=0"]);

  // Unconfined, the box is wired as it always was.
  const open = boxNetworkArguments("box-a", outboundPlan({}, {}), "127.0.0.1::1337");
  assert.deepEqual(valueAfter(open, "--publish"), ["127.0.0.1::1337"]);
  assert.deepEqual(valueAfter(open, "--add-host"), ["host.docker.internal:host-gateway"]);
});

test("the gate forwards the ports it was given and listens on no other", async () => {
  const origin = createServer(socket => socket.end("from the origin"));
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const originPort = (origin.address() as AddressInfo).port;
  // A free port for the gate to listen on, found by asking for one and giving it back.
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const gatePort = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, "close");

  const gate = spawn(process.execPath, ["-e", GATE_SCRIPT, `${gatePort}=127.0.0.1:${originPort}`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await once(gate.stdout!, "data");
    const read = (port: number) =>
      new Promise<string>((resolve, reject) => {
        let text = "";
        const socket = connect(port, "127.0.0.1");
        socket.on("data", chunk => { text += chunk.toString(); });
        socket.on("close", () => resolve(text));
        socket.on("error", reject);
      });
    assert.equal(await read(gatePort), "from the origin");
    // One rule, one listener: the origin's own port is the only other thing answering here.
    assert.equal(gate.exitCode, null);
  } finally {
    gate.kill("SIGTERM");
    origin.close();
  }
  // The handler is what lets `docker stop` end a process that is PID 1 without waiting out the timeout.
  const [code] = (await once(gate, "exit")) as [number | null];
  assert.equal(code, 0);
});

/** An engine that answers inspections from a table and records everything else. */
function engine(answers: Record<string, string | undefined>): { run: DockerRunner; calls: string[] } {
  const calls: string[] = [];
  const run: DockerRunner = async args => {
    const key = args.filter(argument => !argument.startsWith("{{") && argument !== "--format").join(" ");
    if (args.includes("inspect")) {
      const answer = answers[key];
      if (answer === undefined) throw new Error(`Error response from daemon: No such object: ${key}`);
      return answer;
    }
    calls.push(key.startsWith("run ") ? `run ${args[args.indexOf("--name") + 1]}` : key);
    return "";
  };
  return { run, calls };
}

test("a new confined box gets an internal network and a gate; a network of the other kind is replaced, not reused", async () => {
  const plan = outboundPlan({}, RELAY);
  // Left by the same box when it ran unconfined: reusing it would run a "confined" box with a route out.
  const before = engine({ "network inspect box-a-net": "false" });
  await prepareBoxNetwork(before.run, { containerName: "box-a", image: "image:1", publish: "127.0.0.1::1337", plan });
  assert.deepEqual(before.calls, [
    "rm --force box-a-gate",
    "network rm box-a-gate-net",
    "network rm box-a-net",
    "network create --internal box-a-net",
    "network create box-a-gate-net",
    "run box-a-gate",
    "network connect --alias host.docker.internal box-a-net box-a-gate",
  ]);

  // And the other way: a box started with no relay must not inherit a network with no way out, or a stale gate.
  const after = engine({ "network inspect box-a-net": "true" });
  await prepareBoxNetwork(after.run, { containerName: "box-a", image: "image:1", publish: "127.0.0.1::1337", plan: outboundPlan({}, {}) });
  assert.deepEqual(after.calls, ["rm --force box-a-gate", "network rm box-a-gate-net", "network rm box-a-net", "network create box-a-net"]);
});

test("the startup line says what the engine has, not what was asked for", async () => {
  const plan = outboundPlan({}, RELAY);
  const confined = engine({
    "network inspect box-a-net": "true",
    "inspect box-a": "box-a-net ",
    [`inspect ${gateNameFor("box-a")}`]: "running|1337=box-a:1337,8790=host.docker.internal:8790,7777=host.docker.internal:7777",
  });
  const line = await describeOutbound(confined.run, "box-a", plan);
  assert.match(line, /^outbound: confined — /);
  assert.match(line, /host\.docker\.internal:8790, host\.docker\.internal:7777$/);

  // The relay was named after this box was created: it is still on a bridge with a route out, and saying "confined" would be false.
  const stale = engine({ "network inspect box-a-net": "false", "inspect box-a": "box-a-net " });
  assert.match(await describeOutbound(stale.run, "box-a", plan), /^outbound: NOT confined — .*Recreate the box/);

  // A second network is a second way out, whatever the first one is.
  const second = engine({ "network inspect box-a-net": "true", "inspect box-a": "bridge box-a-net ", [`inspect ${gateNameFor("box-a")}`]: "running|" });
  assert.match(await describeOutbound(second.run, "box-a", plan), /^outbound: NOT confined/);

  // No gate, no way in or out: said as what it is, not as "confined" and silence.
  const cut = engine({ "network inspect box-a-net": "true", "inspect box-a": "box-a-net ", [`inspect ${gateNameFor("box-a")}`]: "exited|" });
  assert.match(await describeOutbound(cut.run, "box-a", plan), /cut off/);

  assert.match(await describeOutbound(stale.run, "box-a", outboundPlan({}, {})), /^outbound: not confined — no egress relay is named/);
  assert.match(await describeOutbound(stale.run, "box-a", outboundPlan({}, { ...RELAY, AGENTBOX_EGRESS_ENFORCE: "off" })), /AGENTBOX_EGRESS_ENFORCE=off/);
});
