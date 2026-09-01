/**
 * A test may not reach the network. Attempts fail where they are made, naming the caller.
 *
 * The hermetic environment took the credentials away (scripts/test-env.mjs); this takes
 * the reachability. Together they close the same hole from both sides: a test that calls
 * a vendor cannot authenticate, and a test that calls anything at all cannot leave the
 * machine. Without this the failure is not an error but a *pass* — a test that quietly
 * fetched a real page, spent real money, or went green because a service happened to be
 * up that afternoon.
 *
 * Neither reference implementation has this. OpenClaw compensates with 46
 * `process.env.VITEST` branches scattered through production code, which means the code
 * under test is not the code that ships — the mitigation is worse than the hole. Hermes
 * has one package-scoped socket guard, written after tests polluted a production
 * workspace, and it asserts at teardown that the attempt list is empty so a swallowed
 * exception still fails the test. That is the right shape and this is it, applied once
 * at the process boundary rather than per package.
 *
 * Loopback is allowed, deliberately: several suites stand up a real HTTP server and call
 * it, which is the point of those tests — the wire is the claim. Everything else throws.
 *
 * Loaded with `--import` by the runner, so it is in place before the first test module.
 */

import http from "node:http";
import https from "node:https";

const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/i;

const allowed = host => typeof host === "string" && LOOPBACK.test(host.replace(/:\d+$/, ""));

class BlockedByTestGuard extends Error {
  constructor(target) {
    super(
      `A test tried to reach ${target}. Tests run without network access — see ` +
        `scripts/test-network-guard.mjs. Stub the call, or if this needs a real service, ` +
        `stand one up on loopback.`
    );
    this.name = "BlockedByTestGuard";
  }
}

// fetch, which is what almost everything here uses.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    host = undefined;
  }
  if (!allowed(host)) return Promise.reject(new BlockedByTestGuard(url));
  return realFetch(input, init);
};

// http/https, for anything that builds requests the older way — including SDKs that
// bring their own client.
for (const [module, name] of [
  [http, "http"],
  [https, "https"],
]) {
  const realRequest = module.request;
  module.request = (...args) => {
    const options = typeof args[0] === "string" ? { host: new URL(args[0]).hostname } : args[0];
    const host = options?.hostname ?? options?.host;
    if (!allowed(host)) throw new BlockedByTestGuard(`${name}://${host ?? "?"}`);
    return realRequest.apply(module, args);
  };
  const realGet = module.get;
  module.get = (...args) => {
    const options = typeof args[0] === "string" ? { host: new URL(args[0]).hostname } : args[0];
    const host = options?.hostname ?? options?.host;
    if (!allowed(host)) throw new BlockedByTestGuard(`${name}://${host ?? "?"}`);
    return realGet.apply(module, args);
  };
}
