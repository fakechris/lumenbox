/** One address classification for the host's web reader and the egress relay (INV-1343). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAddress, forbiddenAddress } from "./address.ts";
import { hardDeniedAddress } from "./hard-deny.ts";

test("classes, in both families and through the IPv4-mapped prefix", () => {
  assert.equal(classifyAddress("127.0.0.1"), "loopback");
  assert.equal(classifyAddress("::ffff:127.0.0.1"), "loopback");
  assert.equal(classifyAddress("[::1]"), "loopback");
  assert.equal(classifyAddress("0.0.0.0"), "unspecified");
  assert.equal(classifyAddress("::"), "unspecified");
  assert.equal(classifyAddress("10.1.2.3"), "private");
  assert.equal(classifyAddress("172.31.0.1"), "private");
  assert.equal(classifyAddress("192.168.1.1"), "private");
  assert.equal(classifyAddress("fd00:ec2::254"), "private");
  assert.equal(classifyAddress("169.254.169.254"), "link-local");
  assert.equal(classifyAddress("fe80::1"), "link-local");
  assert.equal(classifyAddress("100.64.0.1"), "carrier");
  assert.equal(classifyAddress("224.0.0.1"), "multicast");
  assert.equal(classifyAddress("ff02::1"), "multicast");
  assert.equal(classifyAddress("198.18.0.1"), "public", "the fake-IP range of transparent proxies stays reachable");
  assert.equal(classifyAddress("93.184.216.34"), "public");
  assert.equal(classifyAddress("2606:4700::1111"), "public");
  assert.equal(classifyAddress("1.2.3"), "malformed");
});

test("the web reader refuses everything inside; the relay refuses only metadata and the host off its channel ports", () => {
  const channels = { channelPorts: [7777] };
  assert.notEqual(forbiddenAddress("10.1.2.3"), undefined);
  assert.equal(hardDeniedAddress("10.1.2.3", 443, channels), undefined, "a box reaching the user's LAN is what the relay is for");
  assert.equal(hardDeniedAddress("169.254.169.254", 80, channels), "cloud metadata address");
  assert.equal(hardDeniedAddress("fe80::1", 80, channels), "cloud metadata address");
  assert.equal(hardDeniedAddress("fd00:ec2::254", 80, channels), "cloud metadata address");
  assert.match(hardDeniedAddress("127.0.0.1", 9, channels) ?? "", /host port 9 is not an explicit channel/);
  assert.match(hardDeniedAddress("::ffff:127.0.0.1", 9, channels) ?? "", /host port 9/);
  assert.match(hardDeniedAddress("0.0.0.0", 9, channels) ?? "", /host port 9/);
  assert.equal(hardDeniedAddress("127.0.0.1", 7777, channels), undefined);
  assert.equal(hardDeniedAddress("93.184.216.34", 443, channels), undefined);
});
