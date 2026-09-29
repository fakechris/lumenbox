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
import { parseReadOutcome } from "../host/read-outcome.ts";
import { docReaderForChat, FeishuDocReader, parseDocUrl, type DocApiClient } from "./feishu-docs.ts";

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

test("a docx link reads as title, source and content, under the line every read leads with", async () => {
  const result = await reader(fakeClient()).read("https://acme.feishu.cn/docx/AbCd1234EfGh5678");
  assert.equal(result.isError, undefined);
  assert.equal(parseReadOutcome(result.text)?.completeness, "full");
  assert.match(
    result.text,
    /^\[read: full — 10 chars\]\n\n# Q3 报表说明\nSource: https:\/\/acme\.feishu\.cn\/docx\/AbCd1234EfGh5678\n\n第一行/
  );
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

test("a long document is cut, and says how much of how much in its first line", async () => {
  const client = fakeClient();
  client.docx.document.rawContent = async () => ({ data: { content: "字".repeat(40_000) } });
  const result = await reader(client).read("https://acme.feishu.cn/docx/AbCd1234EfGh5678");
  assert.ok(result.text.length < 32_000);
  // Was a Chinese sentence at the end of the result, which is the first thing the
  // transcript's cut removes (INV-632). Now it is the head, in the shared vocabulary.
  assert.equal(parseReadOutcome(result.text)?.completeness, "clipped");
  assert.match(result.text, /^\[read: clipped — 30,000 of 40,000 chars; /);
  assert.match(result.text, /export the document and send it as a file/);
});

test("a non-document URL is refused with directions, not fetched", async () => {
  const result = await reader(fakeClient()).read("https://example.com/a-page");
  assert.equal(result.isError, true);
  assert.match(result.text, /WebFetch/);
});

// INV-871: a link is read with the credential of the door it arrived through, falling back to the default door.

function fakeReader(name: string, fails = false) {
  const calls: string[] = [];
  return {
    calls,
    read: async (url: string) => {
      calls.push(url);
      return fails ? { text: `${name} cannot read it`, isError: true } : { text: `${name} read ${url}` };
    },
  };
}

test("a link from the second door is read with that door's app; from the default door, with the default's (INV-871)", async () => {
  const a = fakeReader("A");
  const b = fakeReader("B");
  const readers = new Map([["feishu", a], ["feishu-b", b]]);
  assert.equal((await docReaderForChat("feishu-b:oc_1", readers, "feishu")!.read("u1")).text, "B read u1");
  assert.equal((await docReaderForChat("feishu:oc_2", readers, "feishu")!.read("u2")).text, "A read u2");
  assert.deepEqual([a.calls, b.calls], [["u2"], ["u1"]]);
});

test("when the second door's app cannot read it, the default door's is tried; both failing reports the first (INV-871)", async () => {
  const a = fakeReader("A");
  const b = fakeReader("B", true);
  const readers = new Map([["feishu", a], ["feishu-b", b]]);
  assert.equal((await docReaderForChat("feishu-b:oc_1:om_t", readers, "feishu")!.read("u")).text, "A read u");
  const both = new Map([["feishu", fakeReader("A", true)], ["feishu-b", fakeReader("B", true)]]);
  const failed = await docReaderForChat("feishu-b:oc_1", both, "feishu")!.read("u");
  assert.deepEqual(failed, { text: "B cannot read it", isError: true });
});

test("with only the second door configured, its links are readable; a web conversation gets the one reader there is (INV-871)", async () => {
  const b = fakeReader("B");
  const readers = new Map([["feishu-b", b]]);
  assert.equal((await docReaderForChat("feishu-b:oc_1", readers, "feishu")!.read("u")).text, "B read u");
  assert.equal((await docReaderForChat(undefined, readers, "feishu")!.read("w")).text, "B read w");
  assert.equal(docReaderForChat("feishu:oc_1", new Map(), "feishu"), undefined);
});

test("what can be read does not depend on the door: a tenant-B link through the default door is read by B's app (docs/22 §3, INV-871)", async () => {
  const a = fakeReader("A", true);
  const b = fakeReader("B");
  const readers = new Map([["feishu", a], ["feishu-b", b]]);
  assert.equal((await docReaderForChat("feishu:oc_1", readers, "feishu")!.read("u")).text, "B read u");
  assert.deepEqual([a.calls, b.calls], [["u"], ["u"]], "the arriving door's app first, then the others");
});

