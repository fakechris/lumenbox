/**
 * What no allow list can switch on (INV-1224): the cloud metadata addresses in every spelling
 * a request might use, the host itself except its explicit channels, and nothing else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hardDenied } from "./hard-deny.ts";

const channels = { channelPorts: [7777, 8790] };

test("cloud metadata is refused in every spelling, on every port", () => {
  for (const host of ["169.254.169.254", "169.254.170.2", "metadata.google.internal", "METADATA.GOOGLE.INTERNAL.", "metadata", "fd00:ec2::254", "[fd00:ec2::254]"]) {
    assert.equal(hardDenied(host, 80, channels), "cloud metadata address", host);
    assert.equal(hardDenied(host, 7777, channels), "cloud metadata address", `${host} even on a channel port`);
  }
});

test("the host is refused except on its explicit channels", () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "host.docker.internal", "host.lima.internal", "gateway.docker.internal", "0.0.0.0", "::1", "[::1]"]) {
    assert.equal(hardDenied(host, 7777, channels), undefined, `${host}:7777 is the web port`);
    assert.equal(hardDenied(host, 8790, channels), undefined, `${host}:8790 is the relay`);
    assert.match(hardDenied(host, 11434, channels) ?? "", /host port 11434 is not an explicit channel \(channels: 7777, 8790\)/, host);
    assert.match(hardDenied(host, 3306, channels) ?? "", /host port 3306/, host);
  }
  assert.match(hardDenied("127.0.0.1", 22, { channelPorts: [] }) ?? "", /channels: none/);
});

test("anything else is left to the allow list", () => {
  for (const host of ["example.com", "api.anthropic.com", "10.0.0.5", "192.168.1.9", "169.253.1.1", "1.169.254.1", "fe80::1"]) {
    assert.equal(hardDenied(host, 443, channels), undefined, host);
  }
});
