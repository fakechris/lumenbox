/**
 * Tests for reading Feishu documents with the bot's identity.
 *
 * The claims: a URL is parsed to exactly what it names (never to a guess), a wiki
 * page resolves to the document it wraps, unsupported kinds answer with the way that
 * works today instead of a stack trace, and an API failure names what the person can
 * do about it. Nothing here touches the network — the client is injected.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FeishuDocReader, parseDocUrl, type DocApiClient } from "./feishu-docs.ts";

test("URLs parse to what they name, and only Feishu documents parse at all", () => {
  assert.deepEqual(parseDocUrl("https://acme.feishu.cn/docx/AbCd1234EfGh5678"), {
    kind: "docx",
    token: "AbCd1234EfGh5678",
  });
  assert.deepEqual(parseDocUrl("https://acme.larksuite.com/wiki/XyZw9876VuTs5432?from=chat"), {
    kind: "wiki",
    token: "XyZw9876VuTs5432",
  });
  assert.deepEqual(parseDocUrl("https://acme.feishu.cn/sheets/Sh1234567890t")?.kind, "sheets");
  // Not Feishu, not a doc path, not a URL: all nothing, never a guess.
  assert.equal(parseDocUrl("https://example.com/docx/AbCd1234EfGh5678"), undefined);
  assert.equal(parseDocUrl("https://acme.feishu.cn/messenger"), undefined);
  assert.equal(parseDocUrl("not a url"), undefined);
});

function fakeClient(overrides: Partial<DocApiClient> = {}): DocApiClient {
  return {
    docx: {
      document: {
        get: async () => ({ data: { document: { title: "Q3 报表说明" } } }),
        rawContent: async () => ({ data: { content: "第一行\n第二行的内容" } }),
      },
    },
    wiki: {
      space: {
        getNode: async () => ({ data: { node: { obj_token: "doc_from_wiki", obj_type: "docx" } } }),
      },
    },
    ...overrides,
  };
}

function reader(client: DocApiClient): FeishuDocReader {
  return new FeishuDocReader("app", "secret", async () => client);
}

test("a docx link reads as title, source and content", async () => {
  const result = await reader(fakeClient()).read("https://acme.feishu.cn/docx/AbCd1234EfGh5678");
  assert.equal(result.isError, undefined);
  assert.match(result.text, /^# Q3 报表说明\nSource: https:\/\/acme\.feishu\.cn\/docx\/AbCd1234EfGh5678\n\n第一行/);
});

test("a wiki link resolves to the document it wraps", async () => {
  const asked: string[] = [];
  const client = fakeClient();
  const docx = client.docx.document;
  client.docx.document = {
    ...docx,
    rawContent: async options => {
      asked.push(options.path.document_id);
      return { data: { content: "wiki 里的正文" } };
    },
  };
  const result = await reader(client).read("https://acme.feishu.cn/wiki/XyZw9876VuTs5432");
  assert.deepEqual(asked, ["doc_from_wiki"], "read the wrapped document, not the wiki token");
  assert.match(result.text, /wiki 里的正文/);
});

test("a wiki page wrapping something unreadable says what works instead", async () => {
  const client = fakeClient({
    wiki: {
      space: {
        getNode: async () => ({ data: { node: { obj_token: "sh_1", obj_type: "sheet" } } }),
      },
    },
  });
  const result = await reader(client).read("https://acme.feishu.cn/wiki/XyZw9876VuTs5432");
  assert.equal(result.isError, true);
  assert.match(result.text, /sheet/);
  assert.match(result.text, /导出/);
});

test("unsupported kinds answer with the way that works, without touching the API", async () => {
  const untouched = reader({
    docx: { document: { get: async () => { throw new Error("must not be called"); }, rawContent: async () => { throw new Error("must not be called"); } } },
    wiki: { space: { getNode: async () => { throw new Error("must not be called"); } } },
  });
  for (const [url, hint] of [
    ["https://acme.feishu.cn/sheets/Sh1234567890t", /导出/],
    ["https://acme.feishu.cn/base/Bs1234567890t", /导出/],
    ["https://acme.feishu.cn/file/Fl1234567890t", /文件发到群里/],
  ] as const) {
    const result = await untouched.read(url);
    assert.equal(result.isError, true, url);
    assert.match(result.text, hint);
  }
});

test("an API failure names the fix: share the document with the bot", async () => {
  const client = fakeClient();
  client.docx.document.rawContent = async () => {
    throw new Error("Request failed with status code 403");
  };
  const result = await reader(client).read("https://acme.feishu.cn/docx/AbCd1234EfGh5678");
  assert.equal(result.isError, true);
  assert.match(result.text, /403/);
  assert.match(result.text, /分享.*机器人|机器人.*协作者/);
});

test("a long document is cut and says so", async () => {
  const client = fakeClient();
  client.docx.document.rawContent = async () => ({ data: { content: "字".repeat(40_000) } });
  const result = await reader(client).read("https://acme.feishu.cn/docx/AbCd1234EfGh5678");
  assert.ok(result.text.length < 32_000);
  assert.match(result.text, /已截断/);
});

test("a non-document URL is refused with directions, not fetched", async () => {
  const result = await reader(fakeClient()).read("https://example.com/a-page");
  assert.equal(result.isError, true);
  assert.match(result.text, /WebFetch/);
});
