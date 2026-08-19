/**
 * Tests for the egress wire.
 *
 * Two things are worth testing here rather than at the socket: the parser cannot be walked
 * past its bounds by a malformed preamble, and an incomplete read is distinguishable from an
 * invalid one — a parser that treats "not yet" as "no" turns every slow client into an error.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EgressProtocolError,
  MAX_PREAMBLE_BYTES,
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
  parseProxyTarget,
} from "./protocol.ts";

test("a request round-trips, and the body after it is untouched", () => {
  const wire = encodeRequest({ token: "t0ken", host: "example.com", port: 443 });
  const decoded = decodeRequest(Buffer.concat([Buffer.from(wire), Buffer.from("raw-bytes")]));

  assert.ok(decoded);
  assert.deepEqual(decoded.request, { token: "t0ken", host: "example.com", port: 443 });
  assert.equal(decoded.rest.toString(), "raw-bytes");
});

test("an incomplete preamble is 'not yet', not 'invalid'", () => {
  // The distinction matters: a stream arriving in two packets is normal, and treating it as
  // an error would make the relay fail under exactly the conditions it exists for.
  const wire = encodeRequest({ token: "t", host: "example.com", port: 80 });
  assert.equal(decodeRequest(Buffer.from(wire.slice(0, 20))), undefined);
  assert.ok(decodeRequest(Buffer.from(wire)));
});

test("a preamble that never ends is refused rather than buffered forever", () => {
  const flood = Buffer.alloc(MAX_PREAMBLE_BYTES + 1, 0x41);
  assert.throws(() => decodeRequest(flood), EgressProtocolError);
});

test("hosts and ports are validated, since they reach a resolver and a socket", () => {
  assert.throws(
    () => encodeRequest({ token: "t", host: "example.com\r\nX: y", port: 443 }),
    EgressProtocolError
  );
  assert.throws(() => encodeRequest({ token: "t", host: "example.com", port: 0 }), EgressProtocolError);
  assert.throws(
    () => encodeRequest({ token: "t", host: "example.com", port: 70000 }),
    EgressProtocolError
  );

  const missingPort = Buffer.from("AGENTBOX-EGRESS 1\r\nAuthorization: t\r\nHost: example.com\r\n\r\n");
  assert.throws(() => decodeRequest(missingPort), /No port/);
});

test("an IPv6 literal keeps its brackets and its port", () => {
  const wire = encodeRequest({ token: "t", host: "[2001:db8::1]", port: 8443 });
  const decoded = decodeRequest(Buffer.from(wire));
  assert.equal(decoded?.request.host, "[2001:db8::1]");
  assert.equal(decoded?.request.port, 8443);
});

test("a stream with no token is refused", () => {
  const anonymous = Buffer.from("AGENTBOX-EGRESS 1\r\nHost: example.com:443\r\n\r\n");
  assert.throws(() => decodeRequest(anonymous), /No token/);
});

test("responses carry the failure reason without letting it break the framing", () => {
  const ok = decodeResponse(Buffer.concat([Buffer.from(encodeResponse(true)), Buffer.from("data")]));
  assert.equal(ok?.ok, true);
  assert.equal(ok?.rest.toString(), "data");

  const bad = decodeResponse(Buffer.from(encodeResponse(false, "getaddrinfo ENOTFOUND\r\nnope")));
  assert.equal(bad?.ok, false);
  assert.match(bad?.detail ?? "", /ENOTFOUND/);
  assert.ok(!bad?.detail.includes("\r"), "a newline in the detail would forge a header");
});

test("proxy request lines: CONNECT and absolute-form", () => {
  const connect = parseProxyTarget("CONNECT example.com:443 HTTP/1.1");
  assert.deepEqual(connect, { host: "example.com", port: 443, method: "CONNECT", connect: true });

  // The origin server must not see the absolute URI — most reject it — so the path comes back
  // separately for the caller to rewrite the line with.
  const plain = parseProxyTarget("GET http://example.com/a?b=1 HTTP/1.1");
  assert.deepEqual(plain, {
    host: "example.com",
    port: 80,
    method: "GET",
    connect: false,
    path: "/a?b=1",
  });

  assert.equal(parseProxyTarget("GET /relative HTTP/1.1"), undefined);
  assert.equal(parseProxyTarget("garbage"), undefined);
});
