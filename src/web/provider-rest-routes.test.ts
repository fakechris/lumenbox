/**
 * Settings → Model shows the forecast on the provider status it already has (INV-1612).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderRests } from "../host/provider-rest.ts";
import { providerRestRoute } from "./provider-rest-routes.ts";
import { PROVIDER_REST_JS } from "./provider-rest-ui.ts";

test("the provider status payload carries the forecast line, and the page prints it", async () => {
  assert.match(PROVIDER_REST_JS, /d\.quota/);
  const response = await providerRestRoute("GET /api/provider/rests", {
    refusedAdmin: () => false,
    readJson: async () => ({}),
    rests: new ProviderRests(),
    quotaLine: () => "Forecast, not a bill. Rolling 5h empty. Hold: no (no pause line).",
  });
  assert.equal(response?.status, 200);
  const body = response?.body as { quota?: string; rests: unknown[] };
  assert.match(body.quota ?? "", /Forecast, not a bill/);
  assert.match(body.quota ?? "", /Hold: no/);
  assert.deepEqual(body.rests, []);
});
