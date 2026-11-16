import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { UcpClient, UcpError } from "./ucp.ts";
import type { PoppyCompany } from "./discovery.ts";
import type { PoppySession } from "./session.ts";

function stubCompany(ucpEndpoint?: string): PoppyCompany {
  return {
    protocolVersion: "1.0",
    name: "Test Store",
    domain: "test.example.com",
    identifier: "https://test.example.com",
    extensions: ucpEndpoint ? { ucp: [{ version: "1", endpoint: ucpEndpoint }] } : {},
    raw: {},
  };
}

function stubSession(): PoppySession {
  return {
    company: stubCompany("https://test.example.com/ucp"),
    sid: "sid_test",
    userId: "usr_test",
    version: "1.0",
    sessionJwt: async () => "jwt.test.sig",
    headers: async () => ({
      "Poppy-Session": "jwt.test.sig",
      "Poppy-Version": "1.0",
    }),
  };
}

describe("UcpClient", () => {
  test("throws when Company has no UCP endpoint", () => {
    const company = stubCompany();
    assert.throws(
      () => new UcpClient(company, stubSession()),
      /no UCP endpoint/
    );
  });

  test("constructs with a valid UCP endpoint", () => {
    const company = stubCompany("https://test.example.com/ucp");
    const client = new UcpClient(company, stubSession());
    assert.ok(client);
  });

  test("constructs from agent.protocols UCP endpoint", () => {
    const company: PoppyCompany = {
      protocolVersion: "1.0",
      name: "Proto Store",
      domain: "proto.example.com",
      identifier: "https://proto.example.com",
      agentProtocols: [{ type: "ucp", endpoint: "https://proto.example.com/ucp/v1" }],
      extensions: {},
      raw: {},
    };
    const client = new UcpClient(company, stubSession());
    assert.ok(client);
  });
});

describe("UcpError", () => {
  test("carries detail alongside the message", () => {
    const err = new UcpError("Cart creation failed", '{"error":"out_of_stock"}');
    assert.equal(err.message, "Cart creation failed");
    assert.equal(err.detail, '{"error":"out_of_stock"}');
    assert.ok(err instanceof Error);
  });
});
