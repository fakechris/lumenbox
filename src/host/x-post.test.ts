/**
 * Tests for reading posts on X.
 *
 * The corpus is one real day of one agent's reading (2026-09-19): nineteen posts, taken
 * from FxTwitter's v2 endpoint and from the syndication endpoint as they answered on
 * 2026-09-20. Eighteen are X Articles. The same files are the contract for the OVP-side
 * reader (docs/61 §16.3): same JSON in, same markdown out.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebError } from "./web.ts";
import {
  articleBlockTexts,
  fetchXPost,
  parseFxThread,
  parseSyndication,
  renderArticleBody,
  renderXBody,
  renderXPost,
  sha256,
  syndicationToken,
  xStatusRef,
  XResolversUnavailable,
  type XStatusRef,
} from "./x-post.ts";

const corpusDir = new URL("./fixtures/x-corpus/", import.meta.url);
const corpusIds = [...new Set(readdirSync(corpusDir).map(name => name.split(".")[0]!))].sort();
const readJson = (name: string): unknown => JSON.parse(readFileSync(new URL(name, corpusDir), "utf8"));
const refOf = (id: string): XStatusRef => xStatusRef(`https://x.com/someone/status/${id}`)!;
const FETCHED_AT = "2026-09-20T12:00:00.000Z";

/** The one post on that day that was a plain tweet with a video, not an article. */
const PLAIN_TWEET = "2100814590300889426";

test("the corpus is the day it says it is", () => {
  assert.equal(corpusIds.length, 19);
  for (const id of corpusIds) {
    assert.ok(readdirSync(corpusDir).includes(`${id}.fx2.json`), `${id} has a FxTwitter answer`);
    assert.ok(readdirSync(corpusDir).includes(`${id}.synd.json`), `${id} has a syndication answer`);
  }
});

test("a link to a post is recognised in the shapes X writes it, and nothing else is", () => {
  const cases: [string, string | undefined][] = [
    ["https://x.com/shao__meng/status/2101146387736142138", "2101146387736142138"],
    ["https://twitter.com/shao__meng/status/2101146387736142138?s=20", "2101146387736142138"],
    ["https://mobile.twitter.com/i/web/status/2101146387736142138", "2101146387736142138"],
    ["https://x.com/i/status/2101146387736142138", "2101146387736142138"],
    ["https://x.com/shao__meng", undefined],
    ["https://x.com/i/article/2101142707628568576", undefined],
    ["https://x.com/search?q=jev", undefined],
    ["https://example.com/x.com/status/123", undefined],
    ["not a url", undefined],
  ];
  for (const [url, id] of cases) {
    assert.equal(xStatusRef(url)?.id, id, url);
  }
  assert.equal(xStatusRef("https://x.com/shao__meng/status/2101146387736142138")?.canonical, "https://x.com/shao__meng/status/2101146387736142138");
  assert.equal(xStatusRef("https://x.com/i/web/status/2101146387736142138")?.canonical, "https://x.com/i/web/status/2101146387736142138");
  assert.equal(xStatusRef("https://x.com/i/web/status/2101146387736142138")?.handle, undefined);
});

test("every article in the corpus comes back whole from FxTwitter: the body holds every block", () => {
  let articles = 0;
  for (const id of corpusIds) {
    const post = parseFxThread(readJson(`${id}.fx2.json`), refOf(id));
    assert.equal(post.completeness, "full", `${id} is complete`);
    assert.equal(post.fetcher, "fxtwitter-v2");
    assert.ok(post.author !== undefined && post.author.handle !== "", `${id} has an author`);
    assert.ok(post.published !== undefined && !Number.isNaN(Date.parse(post.published)), `${id} has a date`);
    assert.ok(post.threadIds.includes(id), `${id} lists itself in its thread`);
    if (id === PLAIN_TWEET) {
      assert.equal(post.kind, "tweet");
      assert.ok(post.media.length > 0, "the plain tweet carried a video");
      assert.ok(post.text.length > 100);
      continue;
    }
    articles += 1;
    assert.equal(post.kind, "article", `${id} is an article`);
    assert.ok(post.articleId !== undefined, `${id} names its article`);
    assert.ok(post.articleBody !== undefined && post.articleBody.length > 1000, `${id} has a body`);
    const status = (readJson(`${id}.fx2.json`) as { status: { article: Record<string, unknown> } }).status;
    // Inline links wrap a run of the text in `[...](...)`; the words are what must survive.
    const plain = post.articleBody!.replace(/\[((?:\[[^\]]*\]|[^\]])*)\]\([^)]*\)/g, "$1");
    for (const text of articleBlockTexts(status.article)) {
      assert.ok(plain.includes(text), `${id}: block text survives rendering: ${text.slice(0, 40)}`);
    }
  }
  assert.equal(articles, 18);
});

test("the thread comes with the post, and the post is not repeated in it", () => {
  // blanplan's article was posted with a follow-up in the same thread.
  const post = parseFxThread(readJson("2100868243489530158.fx2.json"), refOf("2100868243489530158"));
  assert.deepEqual(post.threadIds, ["2100868243489530158", "2100915744393642081"]);
  assert.equal(post.thread.length, 1);
  assert.equal(post.thread[0]!.id, "2100915744393642081");
  assert.match(renderXBody(post), /## Thread\n\n2\. /);
});

test("article markup: headings, lists, code, images and links keep their shape", () => {
  const status = (readJson("2100850184129220829.fx2.json") as { status: { article: Record<string, unknown> } }).status;
  const body = renderArticleBody(status.article);
  assert.match(body, /!\[video\]\(https:\/\/video\.twimg\.com\//, "a video resolved from the media list");
  assert.match(body, /!\[[^\]]*\]\(https:\/\/pbs\.twimg\.com\/media\//, "an image resolved from the media list");
  assert.match(body, /\[Embedded post\]\(https:\/\/x\.com\/i\/web\/status\/\d+\)/, "an embedded post");
  assert.match(body, /\[[^\]]+\]\(https:\/\/typesafe\.ai\/\)/, "an inline link");
  const withCode = renderArticleBody(
    (readJson("2101037514945597645.fx2.json") as { status: { article: Record<string, unknown> } }).status.article
  );
  assert.match(withCode, /```json\n\{/, "a code block passed through as X wrote it");
  assert.match(withCode, /\n---\n/, "a divider");
  assert.match(withCode, /^# /m, "a top-level heading");
  assert.match(withCode, /^\d+\. /m, "an ordered list");
  const headed = renderArticleBody(
    (readJson("2100921636597969361.fx2.json") as { status: { article: Record<string, unknown> } }).status.article
  );
  assert.equal(headed.match(/^## /gm)?.length, 5, "every second-level heading");
});

test("an article answered without its body is partial, not empty", () => {
  const payload = readJson("2100921636597969361.fx2.json") as { status: { article: { content: { blocks: unknown[] } } } };
  payload.status.article.content.blocks = [];
  const post = parseFxThread(payload, refOf("2100921636597969361"));
  assert.equal(post.completeness, "partial");
  assert.equal(post.kind, "article");
  assert.equal(post.articleBody, undefined);
  assert.match(post.note ?? "", /without its body/);
});

test("tombstones and absent posts say why, in FxTwitter's own words", () => {
  const ref = refOf("1000000000000000000");
  const gone = parseFxThread({ status: null, thread: null, author: null, code: 404 }, ref);
  assert.equal(gone.completeness, "unavailable");
  assert.match(gone.title, /not-found/);
  assert.match(gone.note ?? "", /deleted, never existed/);
  for (const reason of ["deleted", "suspended", "private", "blocked", "unavailable"]) {
    const post = parseFxThread(
      { status: { type: "tombstone", provider: "twitter", reason, message: `This post is ${reason}.` }, code: 200 },
      ref
    );
    assert.equal(post.completeness, "unavailable", reason);
    assert.match(post.title, new RegExp(reason));
    assert.equal(post.note, `This post is ${reason}.`);
  }
  const odd = parseFxThread({ status: { type: "tombstone", reason: "eaten" }, code: 200 }, ref);
  assert.match(odd.title, /unavailable/);
  assert.equal(parseFxThread("not json at all", ref).completeness, "unavailable");
});

test("the syndication endpoint is always partial, and says what it left out", () => {
  for (const id of corpusIds) {
    const post = parseSyndication(readJson(`${id}.synd.json`), refOf(id));
    assert.equal(post.fetcher, "syndication");
    assert.equal(post.completeness, "partial", id);
    assert.ok(post.author !== undefined, `${id} has an author`);
    assert.ok(post.published !== undefined, `${id} has a date`);
    if (id === PLAIN_TWEET) {
      assert.equal(post.kind, "tweet");
      assert.match(post.note ?? "", /does not carry threads/);
    } else {
      assert.equal(post.kind, "article", id);
      assert.match(post.note ?? "", /previews an article/);
      assert.ok(post.articleId !== undefined, `${id} still names its article`);
    }
  }
  const nothing = parseSyndication("<html>", refOf("1000000000000000000"));
  assert.equal(nothing.completeness, "unavailable");
});

test("the syndication token is what X's embed computes", () => {
  // Checked against the embed's own JavaScript for this id on 2026-09-20.
  assert.equal(syndicationToken("2101146387736142138"), "53cy236i8jz");
});

test("the rendering is markdown with frontmatter that names its own hashes", () => {
  const post = parseFxThread(readJson("2100921636597969361.fx2.json"), refOf("2100921636597969361"));
  const markdown = renderXPost(post, { fetchedAt: FETCHED_AT, rawSha256: "abc", keptIn: "/kept/here" });
  assert.ok(markdown.startsWith("---\n"), "frontmatter first");
  const [, frontmatter, ...rest] = markdown.split("---\n");
  const body = rest.join("---\n").replace(/^\n/, "").replace(/\n$/, "");
  assert.match(frontmatter!, /^kind: article$/m);
  assert.match(frontmatter!, /^title: "Jev 在金融投资场景中的能力及应用实践"$/m);
  assert.match(frontmatter!, /^author_handle: "zway_ai"$/m);
  assert.match(frontmatter!, /^published: 2026-09-18T12:15:26\.000Z$/m);
  assert.match(frontmatter!, /^fetched_at: 2026-09-20T12:00:00\.000Z$/m);
  assert.match(frontmatter!, /^completeness: full$/m);
  assert.match(frontmatter!, /^raw_sha256: abc$/m);
  assert.match(frontmatter!, /^kept_in: "\/kept\/here"$/m);
  assert.match(frontmatter!, /^links: \["https:\/\/x\.com\/i\/article\/2100919171433545729"\]$/m);
  assert.match(frontmatter!, new RegExp(`^body_sha256: ${sha256(body)}$`, "m"), "the body hash is over the body");
  assert.match(body, /^# Jev 在金融投资场景中的能力及应用实践\n\n读财报时/);
});

test("every corpus post renders to the golden markdown", () => {
  for (const id of corpusIds) {
    const post = parseFxThread(readJson(`${id}.fx2.json`), refOf(id));
    const expected = readFileSync(new URL(`${id}.expected.md`, corpusDir), "utf8");
    assert.equal(renderXPost(post, { fetchedAt: FETCHED_AT }), expected, `${id} matches its golden rendering`);
  }
});

/** A transport that answers from the corpus, or refuses, by URL. */
function transportFrom(answers: Record<string, unknown | Error | { status: number; json: unknown }>) {
  const asked: string[] = [];
  const open = async (target: URL) => {
    asked.push(target.toString());
    const match = Object.entries(answers).find(([prefix]) => target.toString().startsWith(prefix));
    if (match === undefined) throw new WebError(`${target.hostname} is not answering.`);
    const answer = match[1];
    if (answer instanceof Error) throw answer;
    const withStatus =
      typeof answer === "object" && answer !== null && "status" in answer && "json" in answer
        ? (answer as { status: number; json: unknown })
        : { status: 200, json: answer };
    const body = Buffer.from(JSON.stringify(withStatus.json), "utf8");
    return { status: withStatus.status, headers: { "content-type": "application/json" }, body, truncated: false };
  };
  return { open, asked };
}

test("FxTwitter is asked first, and the answer is kept on disk with matching hashes", async () => {
  const id = "2101146387736142138";
  const dir = mkdtempSync(join(tmpdir(), "x-post-"));
  try {
    const transport = transportFrom({ "https://fx.test/2/thread/": readJson(`${id}.fx2.json`) });
    const result = await fetchXPost(`https://x.com/shao__meng/status/${id}`, {
      open: transport.open,
      fxtwitterBase: "https://fx.test",
      syndicationBase: "https://synd.test",
      now: () => new Date(FETCHED_AT),
      keepUnder: dir,
    });
    assert.deepEqual(transport.asked, [`https://fx.test/2/thread/${id}`]);
    assert.equal(result.post.completeness, "full");
    assert.ok(result.kept !== undefined);
    const raw = readFileSync(result.kept.raw, "utf8");
    const markdown = readFileSync(result.kept.markdown, "utf8");
    assert.equal(markdown, result.markdown);
    assert.match(markdown, new RegExp(`^raw_sha256: ${sha256(raw)}$`, "m"));
    assert.match(markdown, new RegExp(`^kept_in: "${result.kept.dir.replace(/[\\/]/g, "[\\\\/]")}"$`, "m"));
    assert.equal(JSON.parse(raw).code, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty article body is asked for again through /2/status, and the thread from the first answer is kept", async () => {
  const id = "2100868243489530158";
  const whole = readJson(`${id}.fx2.json`) as { status: { article: { content: { blocks: unknown[] } } }; thread: unknown[] };
  const hollow = JSON.parse(JSON.stringify(whole)) as typeof whole;
  hollow.status.article.content.blocks = [];
  const transport = transportFrom({
    "https://fx.test/2/thread/": hollow,
    "https://fx.test/2/status/": { ...whole, thread: null },
  });
  const result = await fetchXPost(`https://x.com/blanplan/status/${id}`, {
    open: transport.open,
    fxtwitterBase: "https://fx.test",
    now: () => new Date(FETCHED_AT),
    keepUnder: null,
  });
  assert.deepEqual(transport.asked, [`https://fx.test/2/thread/${id}`, `https://fx.test/2/status/${id}`]);
  assert.equal(result.post.completeness, "full");
  assert.ok(result.post.articleBody !== undefined && result.post.articleBody.length > 1000);
  assert.equal(result.post.thread.length, 1, "the thread from the first answer survives");
  assert.equal(result.kept, undefined);
});

test("when FxTwitter cannot be reached the syndication endpoint answers, marked partial and saying why", async () => {
  const id = "2100921636597969361";
  const transport = transportFrom({ "https://synd.test/tweet-result": readJson(`${id}.synd.json`) });
  const result = await fetchXPost(`https://x.com/zway_ai/status/${id}`, {
    open: transport.open,
    fxtwitterBase: "https://fx.test",
    syndicationBase: "https://synd.test",
    now: () => new Date(FETCHED_AT),
    keepUnder: null,
  });
  assert.equal(transport.asked.length, 2);
  assert.match(transport.asked[1]!, new RegExp(`^https://synd\\.test/tweet-result\\?id=${id}&token=`));
  assert.equal(result.post.fetcher, "syndication");
  assert.equal(result.post.completeness, "partial");
  assert.match(result.post.note ?? "", /previews an article/);
  assert.match(result.post.note ?? "", /FxTwitter could not be reached/);
  assert.match(result.markdown, /^completeness: partial$/m);
});

test("a tombstone from FxTwitter is final: the fallback is not asked", async () => {
  // As the real service answers: HTTP 404 with the JSON body, seen live on 2026-09-20.
  const transport = transportFrom({
    "https://fx.test/2/thread/": { status: 404, json: { status: null, thread: null, author: null, code: 404 } },
  });
  const result = await fetchXPost("https://x.com/nobody/status/1000000000000000000", {
    open: transport.open,
    fxtwitterBase: "https://fx.test",
    syndicationBase: "https://synd.test",
    now: () => new Date(FETCHED_AT),
    keepUnder: null,
  });
  assert.equal(transport.asked.length, 1);
  assert.equal(result.post.completeness, "unavailable");
  assert.match(result.markdown, /^completeness: unavailable$/m);
  assert.match(result.markdown, /deleted, never existed/);
});

test("when neither source answers it is its own error, naming both and the post", async () => {
  // Deliberately not the same error as "this post does not exist" (INV-663). Two APIs we
  // do not run being unreachable says nothing about whether the post is there, and the
  // caller has a third route to try — so this no longer suggests the browser, because
  // suggesting it here would stop the caller from taking that route.
  const transport = transportFrom({});
  await assert.rejects(
    fetchXPost("https://x.com/nobody/status/2101146387736142138", {
      open: transport.open,
      fxtwitterBase: "https://fx.test",
      syndicationBase: "https://synd.test",
      keepUnder: null,
    }),
    (error: unknown) => {
      assert.ok(error instanceof XResolversUnavailable, `got ${String(error)}`);
      assert.match(error.message, /fxtwitter:/);
      assert.match(error.message, /syndication:/);
      assert.equal(error.ref.id, "2101146387736142138");
      assert.doesNotMatch(error.message, /browser_open/);
      return true;
    }
  );
});

test("something that is not a post on X is refused before any request", async () => {
  const transport = transportFrom({});
  await assert.rejects(fetchXPost("https://example.com/", { open: transport.open, keepUnder: null }), WebError);
  assert.equal(transport.asked.length, 0);
});
