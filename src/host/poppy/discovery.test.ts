import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { clearDiscoveryCache, discoverCompany, hasUcpExtension, ucpEndpoint } from "./discovery.ts";

/** A minimal valid poppy.json for a domain. */
function minimalPoppyJson(domain: string): Record<string, unknown> {
  return {
    protocol_version: "0.4",
    organization: { name: "Test Co", domain },
    apis: [{ type: "openapi", url: `https://${domain}/api/openapi.json`, description: "Test" }],
  };
}

/** A Shopify-style poppy.json with UCP extension. */
function shopifyPoppyJson(domain: string): Record<string, unknown> {
  return {
    protocol_version: "0.4",
    organization: { name: "Shopify Store", domain },
    auth: {
      scopes: {
        "dev.ucp.shopping.checkout:manage": "Checkout access",
      },
      scope_hints: {
        "dev.ucp.shopping.checkout:manage": {
          changes: "irreversible",
          personal_data: true,
        },
      },
    },
    agent: {
      protocols: [
        { type: "ucp", endpoint: `https://${domain}/.well-known/ucp` },
      ],
    },
    web: {},
    extensions: {
      ucp: [{ version: "1" }],
    },
  };
}

describe("discovery", () => {
  afterEach(() => clearDiscoveryCache());

  it("parses a minimal poppy.json", () => {
    const doc = minimalPoppyJson("example.com");
    assert.equal(doc.protocol_version, "0.4");
    assert.ok(Array.isArray(doc.apis));
  });

  it("detects UCP extension", () => {
    const shopify = shopifyPoppyJson("allbirds.com");

    // Simulate what discoverCompany would produce.
    const company = {
      protocolVersion: "0.4",
      name: "Allbirds",
      domain: "allbirds.com",
      identifier: "https://allbirds.com",
      extensions: {
        ucp: [{ version: "1" }],
      },
      agentProtocols: [{ type: "ucp", endpoint: "https://allbirds.com/.well-known/ucp" }],
      raw: shopify,
    };

    assert.ok(hasUcpExtension(company));
    assert.equal(ucpEndpoint(company), "https://allbirds.com/.well-known/ucp");
  });

  it("no UCP extension when absent", () => {
    const company = {
      protocolVersion: "0.4",
      name: "Test",
      domain: "example.com",
      identifier: "https://example.com",
      raw: {},
    };
    assert.ok(!hasUcpExtension(company));
    assert.equal(ucpEndpoint(company), undefined);
  });

  it("parses scope hints", () => {
    const doc = shopifyPoppyJson("test.com");
    const hints = (doc.auth as Record<string, unknown>).scope_hints as Record<string, unknown>;
    const checkout = hints["dev.ucp.shopping.checkout:manage"] as Record<string, unknown>;
    assert.equal(checkout.changes, "irreversible");
    assert.equal(checkout.personal_data, true);
  });
});
