/**
 * Tests for the third route.
 *
 * The word under test is `unavailable`. It means there was nothing to read, and the read
 * contract is only worth having if it stays true. Two APIs we do not run being unreachable
 * is not the same fact as a post being deleted, and until now both said the same word.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import { dispatchTool, type ToolContext } from "./tools.ts";
import { parseReadOutcome } from "./read-outcome.ts";
import { parseKeptPointer, readFrontmatter } from "./fetched.ts";
import { fetchXPost, XResolversUnavailable } from "./x-post.ts";

const STATUS = "https://x.com/example_author/status/1000000000000000001";
const ARTICLE = "先做错误分析，再决定评估什么。".repeat(40);

/** Both resolvers unreachable, which is what this file is about. */
const resolversDown = async (url: string) => {
  const { xStatusRef: ref } = await import("./x-post.ts");
  throw new XResolversUnavailable(
    `Could not read ${url} from either source.\nfxtwitter: no network in a test\nsyndication: no network in a test`,
    ref(url)!
  );
};

function fixture(webFetch?: ToolContext["webFetch"], xFetch: ToolContext["xFetch"] = resolversDown as never) {
  const root = mkdtempSync(join(tmpdir(), "agentbox-x-fallback-"));
  const registry = new AgentRegistry(join(root, "agents"));
  const agent = registry.create({ name: "Nova" });
  const context = {
    agent,
    registry,
    bus: new AgentBus(registry, async () => {}),
    box: undefined,
    fetchedHome: root,
    xFetch,
    ...(webFetch !== undefined ? { webFetch } : {}),
  } as unknown as ToolContext;
  return { root, context, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const page = (text: string) => ({
  url: STATUS,
  title: "an author on X",
  text,
  truncated: false,
  completeness: "full" as const,
  shape: { chars: text.length, prose: 29, links: 14 },
  fullText: text,
  contentType: "text/html",
  bytes: text.length * 4,
  meta: {},
});

test("both resolvers unreachable falls through to the page, and never calls it full", async () => {
  const body = `Log in\nSign up\n\n${ARTICLE}`;
  const { root, context, cleanup } = fixture(async () => page(body) as never);
  try {
    const result = await dispatchTool("WebFetch", { url: STATUS }, context);
    assert.ok(!result.isError, result.text.slice(0, 200));

    const parsed = parseReadOutcome(result.text);
    assert.equal(parsed?.completeness, "clipped", "not `full`: we know what is missing from it");
    assert.match(result.text, /neither X resolver could be reached/);
    assert.match(result.text, /no thread, author or date/);
    assert.match(result.text, /browser_open/, "and what to do about it");
    assert.ok(result.text.includes("先做错误分析"), "the article's own prose is there");

    // The kept copy says which route answered, so a year later the two are told apart.
    const pointer = parseKeptPointer(result.text)!;
    assert.equal(readFrontmatter(readFileSync(pointer.path, "utf8")).fetcher, "web-fetch");
    assert.ok(pointer.path.startsWith(join(root, "fetched")));
  } finally {
    cleanup();
  }
});

test("when the page will not answer either, the reader hears about all three routes", async () => {
  const { context, cleanup } = fixture(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  try {
    const result = await dispatchTool("WebFetch", { url: STATUS }, context);
    assert.ok(result.isError);
    assert.equal(parseReadOutcome(result.text)?.completeness, "unavailable");
    assert.match(result.text, /from either source/, "the resolvers are named");
    assert.match(result.text, /The page itself did not answer either/, "and so is the third attempt");
  } finally {
    cleanup();
  }
});

test("a tombstone is still unavailable, and does not take the fallback", async () => {
  const tombstone = async () => ({
    post: {
      id: "1000000000000000001",
      canonical: STATUS,
      source: STATUS,
      kind: "tweet" as const,
      completeness: "unavailable" as const,
      unavailableReason: "deleted",
      note: "No post with that id: deleted, never existed, or on a suspended or private account.",
      fetcher: "fxtwitter-v2" as const,
      threadIds: [],
      links: [],
      media: [],
    },
    markdown: "---\ncompleteness: unavailable\n---\n",
  });
  const { context, cleanup } = fixture(async () => {
    throw new Error("the page must not be fetched for a post that is genuinely gone");
  }, tombstone as never);
  try {
    const result = await dispatchTool("WebFetch", { url: STATUS }, context);
    // A post that is not there is the one thing `unavailable` is the true word for, and it
    // returns normally rather than through the catch that carries the fallback.
    assert.equal(parseReadOutcome(result.text)?.completeness, "unavailable");
    assert.doesNotMatch(result.text, /neither X resolver could be reached/);
  } finally {
    cleanup();
  }
});

test("the resolver outage is its own error, carrying which post it was about", async () => {
  await assert.rejects(
    () =>
      fetchXPost(STATUS, {
        keepUnder: null,
        open: async () => {
          throw new Error("no network in a test");
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof XResolversUnavailable, `got ${String(error)}`);
      assert.equal(error.kind, "unavailable");
      assert.equal(error.ref.id, "1000000000000000001");
      assert.match(error.message, /from either source/);
      // Not the place to suggest a browser: the caller has a third route of its own now.
      assert.doesNotMatch(error.message, /browser_open/);
      return true;
    }
  );
});
