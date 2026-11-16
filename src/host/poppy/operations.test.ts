import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { policyLevel, consentDescription, parseOperation, type Operation } from "./operations.ts";

function baseOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op_1",
    type: "checkout",
    description: "Complete your order",
    endpoint: "https://company.example/ops/op_1",
    parameters: {},
    irreversible: false,
    personalData: false,
    ...overrides,
  };
}

describe("policyLevel", () => {
  test("irreversible → L4", () => {
    assert.equal(policyLevel(baseOp({ irreversible: true })), 4);
  });

  test("personalData → L3", () => {
    assert.equal(policyLevel(baseOp({ personalData: true })), 3);
  });

  test("neither → L2", () => {
    assert.equal(policyLevel(baseOp()), 2);
  });

  test("irreversible takes priority over personalData", () => {
    assert.equal(policyLevel(baseOp({ irreversible: true, personalData: true })), 4);
  });
});

describe("consentDescription", () => {
  test("includes the description", () => {
    const desc = consentDescription(baseOp());
    assert.ok(desc.includes("Complete your order"));
  });

  test("includes amount when present", () => {
    const desc = consentDescription(baseOp({
      display: { amount: "99.00", currency: "USD" },
    }));
    assert.ok(desc.includes("99.00"));
    assert.ok(desc.includes("USD"));
  });

  test("warns about irreversible", () => {
    const desc = consentDescription(baseOp({ irreversible: true }));
    assert.ok(desc.includes("irreversible"));
  });

  test("includes display details", () => {
    const desc = consentDescription(baseOp({
      display: {
        title: "Place Order",
        details: [
          { label: "Item", value: "Allbirds Tree Runner" },
          { label: "Size", value: "10" },
        ],
      },
    }));
    assert.ok(desc.includes("Place Order"));
    assert.ok(desc.includes("Allbirds Tree Runner"));
    assert.ok(desc.includes("Size: 10"));
  });
});

describe("parseOperation", () => {
  test("parses a raw operation object", () => {
    const op = parseOperation({
      id: "op_42",
      type: "checkout",
      description: "Buy shoes",
      irreversible: true,
      personal_data: true,
      display: {
        title: "Complete Purchase",
        amount: "120.00",
        currency: "EUR",
        details: [{ label: "Item", value: "Shoes" }],
      },
    }, "https://fallback.example/ops");

    assert.equal(op.id, "op_42");
    assert.equal(op.type, "checkout");
    assert.equal(op.irreversible, true);
    assert.equal(op.personalData, true);
    assert.equal(op.display?.title, "Complete Purchase");
    assert.equal(op.display?.amount, "120.00");
    assert.equal(op.display?.details?.length, 1);
  });

  test("uses default endpoint when none provided", () => {
    const op = parseOperation({ id: "op_1" }, "https://fallback.example/ops");
    assert.equal(op.endpoint, "https://fallback.example/ops");
  });

  test("uses provided endpoint when present", () => {
    const op = parseOperation({ id: "op_1", endpoint: "https://custom.example/ops" }, "https://fallback.example/ops");
    assert.equal(op.endpoint, "https://custom.example/ops");
  });
});
