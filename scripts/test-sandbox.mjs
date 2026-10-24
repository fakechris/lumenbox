/**
 * The operating system's own "no" around a test process, shared by the suite runner
 * (test-floor.mjs) and the flaky-test runner (flaky.mjs) so both deny the network the same way.
 */
import { execFileSync } from "node:child_process";

/**
 * The operating system's own "no": the in-process guard above catches what goes through
 * Node's APIs, and nothing else — a `curl` a test spawns, a `git fetch`, an engine CLI. So the
 * whole run is put under the OS where it can be (INV-1238): macOS `sandbox-exec` with outbound
 * network denied except loopback, Linux a fresh network namespace with only `lo` up. Where
 * neither works, the run says so in one line and goes on with the in-process layer alone;
 * silently skipping the layer would be the one thing worse than not having it. The tests
 * learn which it was from AGENTBOX_TEST_OS_NET, so the self-test asserts the right thing.
 */
export function underOsNetworkDeny(command, args) {
  if (process.env.AGENTBOX_TEST_NO_SANDBOX === "1") return { command, args, osNet: "unavailable", why: "AGENTBOX_TEST_NO_SANDBOX=1" };
  if (process.platform === "darwin") {
    try {
      execFileSync("sandbox-exec", ["-p", "(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip \"localhost:*\"))(allow network-outbound (remote unix-socket))", "/usr/bin/true"], { stdio: "ignore" });
      const profile =
        "(version 1)(allow default)(deny network-outbound)" +
        '(allow network-outbound (remote ip "localhost:*"))' +
        "(allow network-outbound (remote unix-socket))";
      return { command: "sandbox-exec", args: ["-p", profile, command, ...args], osNet: "denied", why: "sandbox-exec deny network-outbound, loopback allowed" };
    } catch (error) {
      return { command, args, osNet: "unavailable", why: `sandbox-exec is not usable here (${error.code ?? error.message})` };
    }
  }
  if (process.platform === "linux") {
    try {
      execFileSync("unshare", ["-rn", "sh", "-c", "ip link set lo up 2>/dev/null || true; true"], { stdio: "ignore" });
      return {
        command: "unshare",
        args: ["-rn", "sh", "-c", 'ip link set lo up 2>/dev/null || true; exec "$0" "$@"', command, ...args],
        osNet: "denied",
        why: "a fresh network namespace (unshare -rn) with only lo",
      };
    } catch (error) {
      return { command, args, osNet: "unavailable", why: `unshare -rn is not usable here (${error.code ?? error.message})` };
    }
  }
  return { command, args, osNet: "unavailable", why: `no OS network sandbox on ${process.platform}` };
}

