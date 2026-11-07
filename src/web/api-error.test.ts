/**
 * What the web server says itself is in the reader's language (INV-1686): a refusal keeps a
 * stable `code` for programs and carries its words in the language the request asked for, the
 * Settings panes the server fills (prompt parts, connectors, the catalog, the usage forecast)
 * follow the same choice, and a route that writes a new refusal in prose fails here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiError, localizedBody } from "./api-error.ts";

const request = (url: string, headers: Record<string, string> = {}) => ({ url, headers }) as unknown as IncomingMessage;

test("a refusal keeps its code and speaks the asker's language: ?lang=, then the cookie, then the browser, then zh", () => {
  const refusal = { ...apiError("agent-unknown", { agent: "ada" }), extra: 1 };
  assert.deepEqual(JSON.parse(JSON.stringify(refusal)), { code: "agent-unknown", error: "No agent ada", extra: 1 }, "built in English; the blanks never reach the JSON");
  const said = (req: IncomingMessage) => localizedBody(refusal, req) as { code: string; error: string; extra: number };
  assert.deepEqual(said(request("/api/x")), { ...refusal, error: "没有 agent ada" }, "no signal at all is the default language");
  assert.equal(said(request("/api/x", { "accept-language": "en-GB,en;q=0.9" })).error, "No agent ada");
  assert.equal(said(request("/api/x", { "accept-language": "en", cookie: "lumen-lang=zh" })).error, "没有 agent ada", "a choice beats the browser");
  assert.equal(said(request("/api/x?lang=en", { cookie: "lumen-lang=zh" })).error, "No agent ada", "?lang= beats the cookie");
  assert.equal(said(request("/api/x?lang=en")).code, "agent-unknown", "the code is the same in every language");
  assert.deepEqual(localizedBody({ error: "from a deeper module" }, request("/")), { error: "from a deeper module" }, "a body that is not an apiError passes as it is");
});

test("Settings speaks the reader's language: prompt parts, connector setup, the catalog and the usage forecast", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-server-words-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port")))); });
  });
  let stop: (() => void) | undefined;
  try {
    const { startWebServer } = await import("./server.ts");
    stop = await startWebServer({ port, host: "127.0.0.1", token: "t0k", useBox: false, onLog: () => {} });
    const read = async (path: string, lang: "zh" | "en") =>
      (await (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: "Bearer t0k", cookie: `lumen-lang=${lang}` } })).json()) as Record<string, any>;
    for (const [lang, part, setup, summary, forecast] of [
      ["zh", "一个回合怎么进行", /凭证与基础信息/, /先问你几个问题/, /^这是预测，不是账单。/],
      ["en", "How a turn works", /Credentials: App ID/, /^Interviews you/, /^Forecast, not a bill\./],
    ] as const) {
      const parts = await read("/api/prompt-parts", lang);
      assert.equal(parts.parts.find((p: { key: string }) => p.key === "conduct").title, part, `${lang}: a prompt part's title`);
      const connectors = await read("/api/connectors", lang);
      assert.match(connectors.providers.find((p: { id: string }) => p.id === "feishu").setup, setup, `${lang}: a connector's setup line`);
      const catalog = await read("/api/catalog", lang);
      assert.match(catalog.experts.find((e: { slug: string }) => e.slug === "designer").summary, summary, `${lang}: a catalog line`);
      assert.match((await read("/api/provider/rests", lang)).quota, forecast, `${lang}: the usage forecast`);
      const missing = await read("/api/agents/config-versions?agent=nobody", lang);
      assert.deepEqual([missing.code, missing.error], ["agent-unknown", lang === "zh" ? "没有 agent nobody" : "No agent nobody"], `${lang}: a route module's refusal, through send`);
    }
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * Prose a route still answers with as `error`, each with the reason it is not in the bundle. A
 * new entry needs the same kind of reason: the words come from a vendor or a model, or no person
 * reads them.
 */
const KEPT_AS_WRITTEN: Record<string, string[]> = {
  // A probe result shown beside the model a person is testing, next to the vendor's own error text.
  "src/web/supervision-routes.ts": ["the model answered but did not call a tool; a supervisor needs tool calls"],
  // The box's resource reading, one field of a diagnostics view whose other fields are the box's own output.
  "src/web/diagnostics-routes.ts": ["no box connected"],
  // The MCP side door answers programs, in JSON-RPC; it never reaches the page.
  "src/web/mcp-server.ts": ["MCP is a POST endpoint.", "This endpoint needs an access token issued to a person."],
};

/** Each `error:` written as a literal, with its line: the prose a route answers with. */
function refusalsIn(text: string): { line: number; said: string }[] {
  return [...text.matchAll(/\berror: ("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g)]
    .map(match => ({ line: text.slice(0, match.index).split("\n").length, said: match[1]!.slice(1, -1) }))
    .filter(({ said }) => /[A-Za-z一-鿿]{2}/.test(said));
}

/** The server and every module beside it that answers a route. */
function routeSources(): { path: string; text: string }[] {
  const dir = import.meta.dirname;
  return readdirSync(dir)
    .filter(name => /^(server|mcp-server|agent-facts|jev-settings)\.ts$|-routes\.ts$/.test(name))
    .map(name => ({ path: `src/web/${name}`, text: readFileSync(join(dir, name), "utf8") }));
}

test("no route answers a refusal in prose outside the bundle", () => {
  const sources = routeSources();
  assert.ok(sources.length > 15, "the server and its route modules are all read");
  const found = sources.flatMap(({ path, text }) =>
    refusalsIn(text)
      .filter(({ said }) => !(KEPT_AS_WRITTEN[path] ?? []).includes(said))
      .map(({ line, said }) => `${path}:${line} ${said}`)
  );
  assert.deepEqual(found, [], 'answer apiError("<code>", vars) and put the words in src/i18n/server-errors.ts as ["中文", "English"]');
});

test("the guard finds a refusal written in prose, in either language, and not one built from the bundle", () => {
  const planted = 'send(res, 404, { error: "No such thing." }); send(res, 409, { error: `没有 ${who}` }); send(res, 400, apiError("agent-none")); send(res, 400, { error: reason });';
  assert.deepEqual(refusalsIn(planted).map(hit => hit.said), ["No such thing.", "没有 ${who}"]);
});
