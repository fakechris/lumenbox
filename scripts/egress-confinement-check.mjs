#!/usr/bin/env node
/**
 * Is a box's way out the relay, or only pointed at it? (INV-816)
 *
 * Starts a box of its own with an egress relay named, then asks the box the question an agent
 * with `sudo` can ask: what happens to a connection that does not go through the proxy. A box
 * whose outbound traffic is only steered by `HTTP_PROXY` answers "it leaves"; this check fails
 * there. It also proves the other half — that confining the box did not break it: the daemon
 * answers, a proxied command and the browser still get out, and the relay still records which
 * call each connection belonged to.
 *
 *   node --experimental-transform-types scripts/egress-confinement-check.mjs --name lumenbox-egress-check-1
 *
 *   --name <container>   required, must start with `lumenbox-` and must not exist yet: this
 *                        never runs against a box somebody uses
 *   --keep               leave the box (and its network, gate and volumes) for inspection
 *   --relay-bind <addr>  where the relay listens (default 127.0.0.1, which a box reaches as
 *                        host.docker.internal on Docker Desktop and OrbStack; a Linux engine
 *                        needs the bridge address)
 *
 * Needs a Docker engine and the box image; reaches example.com and a package index through the
 * relay. Not part of `npm test`, which is hermetic.
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const name = flag("--name");
const keep = argv.includes("--keep");
const relayBind = flag("--relay-bind") ?? "127.0.0.1";
if (name === undefined || !name.startsWith("lumenbox-") || name.length < 12) {
  console.error("Give the box a name of its own: --name lumenbox-egress-check-<something>");
  process.exit(2);
}
const exists = (() => {
  try { execFileSync("docker", ["inspect", name], { stdio: "ignore" }); return true; } catch { return false; }
})();
if (exists) {
  console.error(`${name} already exists. This check only runs in a box it created.`);
  process.exit(2);
}

// Its own home: the box token and anything else written land here, not in an installation.
process.env.AGENTBOX_HOME = mkdtempSync(join(tmpdir(), "egress-check-home-"));
delete process.env.AGENTBOX_CONTAINER;

const { BoxManager, defaultBoxConfig, generateToken } = await import("../src/box/docker.ts");
const { startEgressRelay } = await import("../src/egress/relay.ts");
const { encodeCall } = await import("../src/egress/call.ts");

const token = generateToken();
const events = [];
const listening = server => new Promise(resolve => server.once("listening", resolve));

// Something on this machine's loopback that is not a channel: a box must not reach it directly.
const marker = `private-${Date.now()}`;
const privateService = createServer((_request, response) => response.end(marker));
privateService.listen(0, "127.0.0.1");
await listening(privateService);
const privatePort = privateService.address().port;

const relay = startEgressRelay({
  token,
  port: 0,
  host: relayBind,
  allow: ["example.com", "pypi.org", "files.pythonhosted.org"],
  channelPorts: [],
  onEvent: event => events.push(event),
});
await listening(relay);
const relayPort = relay.address().port;
process.env.AGENTBOX_EGRESS_RELAY = `host.docker.internal:${relayPort}`;
process.env.AGENTBOX_EGRESS_TOKEN = token;

const manager = new BoxManager(defaultBoxConfig({ containerName: name, token, withHost: false }));
const results = [];
let failed = 0;
async function check(title, run) {
  try {
    const detail = await run();
    results.push(`  ok    ${title}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failed += 1;
    results.push(`  FAIL  ${title} — ${error instanceof Error ? error.message : String(error)}`);
  }
}
const expect = (condition, message) => { if (!condition) throw new Error(message); };

const NO_PROXY_ENV = "env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy";
let seq = 0;
const call = () => encodeCall({ agentId: "egress-check", turnId: "turn-1", toolUseId: `call-${++seq}` });
const attributed = (host, toolUseId) =>
  events.some(event => event.host === host && event.allowed && event.attribution === "call" && event.toolUseId === toolUseId);

try {
  console.log(`starting ${name} with the relay at host.docker.internal:${relayPort}`);
  const { client } = await manager.up({ onOutput: line => console.log(`  ${line}`) });

  /** Runs a command the way an agent's shell tool does, and says how a direct connection ended. */
  const direct = async (prefix, url) => {
    const result = await client.exec(`${prefix} curl -sS -o /dev/null -m 8 -w '%{http_code}' ${url}; echo " exit=$?"`, { call: call(), timeoutMs: 30_000 });
    const exit = /exit=(\d+)/.exec(result.stdout)?.[1];
    return { exit, text: `${result.stdout.trim()} ${result.stderr.trim()}`.trim() };
  };

  // --- what must be refused -------------------------------------------------------------
  await check("a command with the proxy variables removed does not reach the internet", async () => {
    const got = await direct(NO_PROXY_ENV, "https://example.com");
    expect(got.exit !== "0", `it connected: ${got.text}`);
    return `curl exit ${got.exit}`;
  });
  await check("nor by address, where no name has to resolve", async () => {
    const got = await direct(NO_PROXY_ENV, "http://1.1.1.1/");
    expect(got.exit !== "0", `it connected: ${got.text}`);
    return `curl exit ${got.exit}`;
  });
  await check("the cloud metadata address does not answer a direct connection", async () => {
    const got = await direct(NO_PROXY_ENV, "http://169.254.169.254/latest/meta-data/");
    expect(got.exit !== "0", `it connected: ${got.text}`);
    return `curl exit ${got.exit}`;
  });
  await check("sudo does not change that", async () => {
    const got = await direct(`sudo ${NO_PROXY_ENV}`, "https://example.com");
    expect(got.exit !== "0", `it connected: ${got.text}`);
    return `curl exit ${got.exit}`;
  });
  await check("a loopback service on this machine that is not a channel is out of reach", async () => {
    const got = await client.exec(`${NO_PROXY_ENV} curl -s -m 6 http://host.docker.internal:${privatePort}/ || true`, { call: call() });
    expect(!got.stdout.includes(marker), "the box read a service bound to this machine's loopback");
    return "no answer";
  });
  await check("root in the box cannot give itself a route out", async () => {
    // What `ip route add default` does, without needing the tool: the kernel decides.
    const script = [
      "import fcntl, socket, struct",
      "sa = lambda ip: struct.pack('=H2s4s8s', socket.AF_INET, b'', socket.inet_aton(ip), b'')",
      "gw = socket.gethostbyname('host.docker.internal')",
      "s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)",
      "try:",
      "    fcntl.ioctl(s, 0x890B, (sa('0.0.0.0') + sa(gw) + sa('0.0.0.0') + struct.pack('=H', 3)).ljust(120, b'\\0'))",
      "    print('route added')",
      "except OSError as error:",
      "    print('refused:', error.strerror)",
    ].join("\n");
    await client.writeFile("/tmp/egress-check-route.py", script);
    const tried = await client.exec("sudo python3 /tmp/egress-check-route.py 2>&1", { call: call() });
    const got = await direct(`sudo ${NO_PROXY_ENV}`, "https://example.com");
    expect(got.exit !== "0", `after "${tried.stdout.trim()}" it connected: ${got.text}`);
    return `${tried.stdout.trim()}; curl exit ${got.exit}`;
  });

  // --- what must still work -------------------------------------------------------------
  await check("the daemon answers from this machine", async () => {
    const health = await client.health();
    expect(health.resolution !== undefined, "no display reported");
    return `display ${health.display}`;
  });
  await check("a command under its call's proxy variables gets out, and the relay knows whose it was", async () => {
    const id = call();
    const got = await client.exec("curl -sS -o /dev/null -m 20 -w '%{http_code}' https://example.com", { call: id, timeoutMs: 40_000 });
    expect(got.stdout.trim() === "200", `status ${got.stdout.trim()} ${got.stderr.trim()}`);
    expect(attributed("example.com", `call-${seq}`), "the relay has no attributed event for example.com");
    return "200, attributed to the call";
  });
  await check("a package install through the proxy works and is attributed", async () => {
    const id = call();
    const mine = `call-${seq}`;
    const got = await client.exec(
      "rm -rf /tmp/egress-check-venv /tmp/egress-check-wheels && python3 -m venv /tmp/egress-check-venv && " +
        "/tmp/egress-check-venv/bin/pip download --quiet --no-deps --no-cache-dir --index-url https://pypi.org/simple -d /tmp/egress-check-wheels six==1.16.0 && ls /tmp/egress-check-wheels",
      { call: id, timeoutMs: 180_000 }
    );
    expect(/six-1\.16\.0/.test(got.stdout), `no wheel: ${got.stdout.trim()} ${got.stderr.trim().slice(-300)}`);
    expect(attributed("pypi.org", mine), "the relay has no attributed event for pypi.org");
    return `${got.stdout.trim()}, attributed to the call`;
  });
  await check("the browser opens a page through the relay, attributed to its action", async () => {
    const id = call();
    const mine = `call-${seq}`;
    const opened = await client.browser({ op: "open", url: "https://example.com/", call: id });
    const text = JSON.stringify(opened);
    expect(/Example Domain/.test(text), `the page did not load: ${text.slice(0, 300)}`);
    expect(attributed("example.com", mine), "the relay has no attributed event for the browser's connection");
    return "Example Domain, attributed to the action";
  });
  await check("the allow list still decides what the proxy opens", async () => {
    const got = await client.exec("curl -sS -o /dev/null -m 15 -w '%{http_code}' https://www.wikipedia.org/ ; true", { call: call(), timeoutMs: 30_000 });
    expect(got.stdout.trim() !== "200", "a host outside the allow list was opened");
    expect(events.some(event => event.host === "www.wikipedia.org" && !event.allowed && event.reason === "not allowed"), "no refusal was recorded");
    return "refused: not allowed";
  });
} catch (error) {
  failed += 1;
  results.push(`  FAIL  the box came up — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  relay.close();
  privateService.close();
  if (keep) {
    console.log(`left in place: ${name} (see \`docker ps -a --filter name=${name}\`, \`docker network ls --filter name=${name}\`, \`docker volume ls --filter name=${name}\`)`);
  } else {
    await manager.down({ remove: true }).catch(error => console.error(`could not remove ${name}: ${error.message}`));
    for (const volume of [`${name}-work`, `${name}-config`]) {
      try { execFileSync("docker", ["volume", "rm", volume], { stdio: "ignore" }); } catch { /* never created, or still held */ }
    }
  }
}

console.log(`\negress confinement, ${name}:`);
console.log(results.join("\n"));
console.log(failed === 0 ? "\nconfined: the relay is the box's only way out, and the box still works." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
