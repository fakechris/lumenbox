/** The decision-model client and its switch (INV-1412): request shape, strict answers, and the three modes. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type JevAsk, type JevMode, type JevRequest, JevError, type ShadowEntry, type SwitchDeps, switched, typesafeClient } from "./jev.ts";

const TOKEN = "ts_test_token_value_0123456789";

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const request: JevRequest = {
  state: { text: "hello" },
  questions: {
    yes: { type: "noul", instructions: "Is `text` a greeting?" },
    pick: { type: "choice", instructions: "Which language is `text`?", criteria: { en: "English", zh: "Chinese" } },
  },
};

test("the client posts state and questions with the key, and the images header only when an image or a box is asked about", async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const ask = typesafeClient({
    token: TOKEN,
    fetch: fakeFetch(200, { model: "jev-1.14.0", answers: { yes: { type: "noul", noul: 0.97 }, pick: { type: "choice", choice: "en", confidence: 0.9, probabilities: { en: 0.9, zh: 0.1 } } }, usage: { input_tokens: 40 } }, seen),
  });
  const result = await ask(request);
  assert.equal(result.answers.yes?.type, "noul");
  assert.equal(result.inputTokens, 40);
  const headers = seen[0]!.init!.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["TypeSafe-Danger-Zone-Images"], undefined, "a text-only request does not opt into images");
  const sent = JSON.parse(String(seen[0]!.init!.body)) as { model: string; assets?: unknown };
  assert.equal(sent.model, "jev-latest");
  assert.equal(sent.assets, undefined);

  const imageSeen: { url?: string; init?: RequestInit }[] = [];
  const withImage = typesafeClient({ token: TOKEN, fetch: fakeFetch(200, { model: "m", answers: { where: { type: "box", box: { top: 0.1, bottom: 0.2, left: 0.3, right: 0.4 }, confidence: 0.8 } } }, imageSeen) });
  await withImage({ state: { screen: "ref-1" }, images: [{ ref: "ref-1", format: "jpg", base64: "AAAA" }], questions: { where: { type: "box", instructions: "the button in `screen`" } } });
  assert.equal((imageSeen[0]!.init!.headers as Record<string, string>)["TypeSafe-Danger-Zone-Images"], "true");
  assert.deepEqual(JSON.parse(String(imageSeen[0]!.init!.body)).assets, { "ref-1": { type: "image", format: "jpg", data_base64: "AAAA" } });
});

test("an answer off its question's shape is an error, never a guess", async () => {
  const cases: [string, unknown][] = [
    ["missing", { yes: { type: "noul", noul: 0.5 } }],
    ["not a probability", { yes: { type: "noul", noul: 1.5 }, pick: { type: "choice", choice: "en", confidence: 0.9 } }],
    ["not one of the options", { yes: { type: "noul", noul: 0.5 }, pick: { type: "choice", choice: "fr", confidence: 0.9 } }],
    ["expected noul", { yes: { type: "choice", choice: "en", confidence: 1 }, pick: { type: "choice", choice: "en", confidence: 0.9 } }],
  ];
  for (const [why, answers] of cases) {
    const ask = typesafeClient({ token: TOKEN, fetch: fakeFetch(200, { model: "m", answers }) });
    await assert.rejects(ask(request), (error: Error) => error instanceof JevError && error.message.includes(why), why);
  }
});

test("a refused request says the status and the vendor's error kind, and never the key or the request", async () => {
  const ask = typesafeClient({ token: TOKEN, fetch: fakeFetch(401, { error: { type: "authentication_error", message: `bad key ${TOKEN} for hello` } }) });
  await assert.rejects(ask(request), (error: Error) => {
    assert.match(error.message, /401 \(authentication_error\)/);
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!error.message.includes("hello"));
    return true;
  });
  const down = typesafeClient({ token: TOKEN, fetch: (async () => { throw new Error(`connect failed to ${TOKEN}`); }) as typeof fetch });
  await assert.rejects(down(request), (error: Error) => !error.message.includes(TOKEN) && /could not be reached/.test(error.message));
});

function deps(mode: JevMode, ask: JevAsk | undefined, records: ShadowEntry[], logs: string[] = []): SwitchDeps {
  return { mode: () => mode, client: () => ask, record: entry => records.push(entry), log: line => logs.push(line) };
}

test("off makes no call; on uses the decision model and falls back when it fails; no key is off", async () => {
  let calls = 0;
  const ask: JevAsk = async () => { calls += 1; return { model: "m", answers: {}, ms: 1 }; };
  const records: ShadowEntry[] = [];
  const paths = (jevAnswer: () => Promise<string>) => ({ own: async () => "own", jev: async () => { await ask(request); return jevAnswer(); }, summary: (v: string) => v });

  assert.equal(await switched("memory_judge", paths(async () => "jev"), deps("off", ask, records)), "own");
  assert.equal(calls, 0, "off never reaches the decision model");
  assert.equal(await switched("memory_judge", paths(async () => "jev"), deps("on", undefined, records)), "own", "on without a key is off");
  assert.equal(calls, 0);

  assert.equal(await switched("memory_judge", paths(async () => "jev"), deps("on", ask, records)), "jev");
  const logs: string[] = [];
  assert.equal(await switched("memory_judge", paths(async () => { throw new JevError("the decision model answered 500"); }), deps("on", ask, records, logs)), "own");
  assert.match(logs[0]!, /memory_judge: the decision model failed/);
  assert.equal(records.length, 0, "only shadow writes the comparison log");
});

test("shadow answers with the default path and records both summaries, or the decision model's failure", async () => {
  const records: ShadowEntry[] = [];
  const ask: JevAsk = async () => ({ model: "m", answers: {}, ms: 1 });
  const answer = await switched("answer_review", { own: async () => "PASS", jev: async () => "NON_ANSWER", summary: v => v }, deps("shadow", ask, records));
  assert.equal(answer, "PASS");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(records.length, 1);
  assert.deepEqual({ point: records[0]!.point, own: records[0]!.own, jev: records[0]!.jev }, { point: "answer_review", own: "PASS", jev: "NON_ANSWER" });

  await switched("answer_review", { own: async () => "PASS", jev: async () => { throw new JevError("timeout"); }, summary: v => v }, deps("shadow", ask, records));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(records[1]!.error, "timeout");
  assert.equal(records[1]!.jev, undefined);
});

test("every call is one log line of numbers and ids, a failure too, and never the key or the wording", async () => {
  const { loggedAsk } = await import("./jev.ts");
  const lines: import("./jev.ts").CallEntry[] = [];
  const ok = loggedAsk(async () => ({ model: "jev-1.14.0", ms: 3, inputTokens: 120, answers: { yes: { type: "noul", noul: 0.9712 }, pick: { type: "choice", choice: "en", confidence: 0.8, probabilities: { en: 0.8 } } } }), "answer_review", entry => lines.push(entry));
  await ok({ ...request, images: [{ ref: "r", format: "jpg", base64: "SECRETPIXELS" }] });
  assert.deepEqual({ point: lines[0]!.point, model: lines[0]!.model, inputTokens: lines[0]!.inputTokens, questions: lines[0]!.questions, images: lines[0]!.images, answers: lines[0]!.answers },
    { point: "answer_review", model: "jev-1.14.0", inputTokens: 120, questions: { noul: 1, choice: 1 }, images: 1, answers: { yes: 0.971, pick: ["en", 0.8] } });
  const text = JSON.stringify(lines[0]);
  for (const leak of ["greeting", "hello", "SECRETPIXELS", TOKEN]) assert.ok(!text.includes(leak), `the log has no ${leak}`);

  const failing = loggedAsk(async () => { throw new JevError("the decision model answered 500"); }, "memory_select", entry => lines.push(entry));
  await assert.rejects(failing(request), /500/);
  assert.equal(lines[1]!.error, "the decision model answered 500");
  const unwritable = loggedAsk(async () => ({ model: "m", ms: 1, answers: {} }), undefined, () => { throw new Error("disk full"); });
  assert.deepEqual((await unwritable(request)).answers, {}, "a log that cannot be written never fails the call");
});
