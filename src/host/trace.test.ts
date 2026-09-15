/**
 * Tests for the OTLP tracer: the payload shape a collector actually receives,
 * and the two failure disciplines — a dead collector must cost the caller
 * nothing, and an unconfigured one must not exist at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { otlpTracer, tracerFromEnv, tracesEndpoint } from "./trace.ts";

interface Posted {
  url: string;
  body: ReturnType<typeof JSON.parse>;
}

/** A fetch that records what would have been sent and answers 200. */
function capturingFetch(posted: Posted[], status = 200): typeof fetch {
  return (async (input: unknown, init?: { body?: unknown }) => {
    posted.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
}

test("the endpoint is the base plus /v1/traces, never doubled", () => {
  assert.equal(tracesEndpoint("http://opik:8080/api/v1/private/otel"), "http://opik:8080/api/v1/private/otel/v1/traces");
  assert.equal(tracesEndpoint("http://opik:8080/api/v1/private/otel/"), "http://opik:8080/api/v1/private/otel/v1/traces");
  assert.equal(
    tracesEndpoint("http://opik:8080/api/v1/private/otel/v1/traces"),
    "http://opik:8080/api/v1/private/otel/v1/traces"
  );
});

test("no AGENTBOX_TRACE_URL means no tracer, blank means the same", () => {
  assert.equal(tracerFromEnv({}), undefined);
  assert.equal(tracerFromEnv({ AGENTBOX_TRACE_URL: "  " }), undefined);
  assert.ok(tracerFromEnv({ AGENTBOX_TRACE_URL: "http://collector:4318" }) !== undefined);
});

test("a span is posted as OTLP JSON with the turn's trace id and encoded attributes", async () => {
  const posted: Posted[] = [];
  const tracer = otlpTracer("http://collector:4318", { fetchImpl: capturingFetch(posted) });

  const span = tracer.start(
    "llm.round",
    {
      "gen_ai.request.model": "claude-opus-5",
      "agentbox.round": 0,
      "agentbox.cached": true,
    },
    { traceId: "123e4567-e89b-42d3-a456-426614174000" }
  );
  span.end({ "gen_ai.usage.input_tokens": 1234 });
  await tracer.flush();

  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.url, "http://collector:4318/v1/traces");

  const resource = posted[0]!.body.resourceSpans[0].resource.attributes;
  assert.ok(
    resource.some((a: { key: string; value: { stringValue: string } }) =>
      a.key === "service.name" && a.value.stringValue === "agentbox-host"),
    "the resource names this service"
  );

  const [sent] = posted[0]!.body.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(sent.name, "llm.round");
  assert.equal(sent.kind, 3, "an outbound LLM call is a CLIENT span");
  assert.equal(sent.traceId, "123e4567e89b42d3a456426614174000", "the uuid's dashes are stripped");
  assert.match(sent.spanId, /^[0-9a-f]{16}$/);
  assert.ok(Number(sent.endTimeUnixNano) >= Number(sent.startTimeUnixNano));
  assert.equal(sent.status.code, 1, "a clean end is STATUS_CODE_OK");

  const attrs = Object.fromEntries(sent.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]));
  assert.deepEqual(attrs["gen_ai.request.model"], { stringValue: "claude-opus-5" });
  assert.deepEqual(attrs["gen_ai.usage.input_tokens"], { intValue: "1234" }, "int64 is a string in OTLP JSON");
  assert.deepEqual(attrs["agentbox.cached"], { boolValue: true });
});

test("a span ended with an error is sent, marked failed, its message bounded", async () => {
  const posted: Posted[] = [];
  const tracer = otlpTracer("http://collector:4318", { fetchImpl: capturingFetch(posted) });

  tracer.start("llm.round").end({}, new Error(`x${"y".repeat(1_000)}`));
  await tracer.flush();

  const [sent] = posted[0]!.body.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(sent.status.code, 2, "STATUS_CODE_ERROR");
  assert.ok(sent.status.message.length <= 300, `the message is bounded, was ${sent.status.message.length}`);
});

test("a bad trace-id hint gets a fresh valid one instead of a broken trace", async () => {
  const posted: Posted[] = [];
  const tracer = otlpTracer("http://collector:4318", { fetchImpl: capturingFetch(posted) });
  tracer.start("llm.round", {}, { traceId: "not-a-uuid" }).end();
  await tracer.flush();
  const [sent] = posted[0]!.body.resourceSpans[0].scopeSpans[0].spans;
  assert.match(sent.traceId, /^[0-9a-f]{32}$/);
});

test("a dead collector costs the caller nothing: no throw, one throttled log line", async () => {
  const logged: string[] = [];
  const failing = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const tracer = otlpTracer("http://collector:4318", {
    fetchImpl: failing,
    log: line => logged.push(line),
  });

  tracer.start("llm.round").end();
  await tracer.flush();
  tracer.start("llm.round").end();
  await tracer.flush();

  assert.equal(logged.length, 1, "the second failure inside the throttle window stays quiet");
  assert.match(logged[0]!, /dropped 1 span\(s\): connection refused/);
});

test("a collector answering 500 is a failure, not a delivery", async () => {
  const logged: string[] = [];
  const tracer = otlpTracer("http://collector:4318", {
    fetchImpl: capturingFetch([], 500),
    log: line => logged.push(line),
  });
  tracer.start("llm.round").end();
  await tracer.flush();
  assert.match(logged[0]!, /collector returned 500/);
});
