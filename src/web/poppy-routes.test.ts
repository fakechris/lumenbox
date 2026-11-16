/** Poppy's public routes: only what a Company must fetch, and nothing that runs as a page on this origin. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoppyManager } from "../host/poppy/manager.ts";
import { poppyRoute } from "./poppy-routes.ts";

const poppy = {
  ready: true,
  clientMetadata: () => ({ client_id: "https://agent.example/poppy/agent.json" }),
  jwks: () => ({ keys: [] }),
  status: () => ({ activeSessions: ["shop.example"] }),
  handleCallback: async () => ({ companyName: "<img src=x onerror=alert(1)>", scopes: "openid" }),
} as unknown as PoppyManager;
const at = (path: string) => poppyRoute(`GET ${path.split("?")[0]}`, new URL(path, "https://agent.example"), poppy);

test("the callback answers in plain text, whatever a link or a Company put in it", async () => {
  for (const answer of [await at("/poppy/callback?error=<script>alert(1)</script>"), await at("/poppy/callback?code=c&state=s")]) {
    assert.equal(answer?.status, 200);
    assert.equal(answer?.type, "text/plain");
  }
  assert.equal((await at("/poppy/callback?code=c"))?.status, 400);
});

test("what a Company verifies against is public; what the agent holds is not, and nothing answers while Poppy is off", async () => {
  assert.equal((await at("/poppy/jwks.json"))?.status, 200);
  assert.equal((await at("/poppy/agent.json"))?.status, 200);
  const profile = await at("/poppy/ucp/2026-08-25.json");
  assert.equal(profile?.status, 200, "the UCP platform profile a Company fetches to negotiate");
  assert.ok(profile);
  assert.deepEqual((profile.body as { ucp: { payment_handlers: unknown } }).ucp.payment_handlers, {}, "no payment handler: the person pays at continue_url");
  assert.equal(await at("/poppy/status"), undefined, "sessions and visited domains are not answered before sign-in");
  assert.equal(await poppyRoute("GET /poppy/jwks.json", new URL("https://agent.example/poppy/jwks.json"), undefined), undefined);
});
