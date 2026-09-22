/**
 * Every reader answers in the same first line.
 *
 * The architecture guard stops a seventh wording from appearing; these tests check that
 * the six readers that can be driven from here actually put the line first, with numbers
 * that match what they handed over. The two that cannot be reached without a network or a
 * Feishu tenant — WebSearch and ReadFeishuDoc — are covered by the guard and by their own
 * formatting code paths.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import { dispatchTool, type ToolContext } from "./tools.ts";
import { parseReadOutcome } from "./read-outcome.ts";
import { WebError } from "./web.ts";

function fixture(extra: Partial<ToolContext> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentbox-read-contract-"));
  const registry = new AgentRegistry(join(root, "agents"));
  const agent = registry.create({ name: "Ada" });
  const context = {
    agent,
    registry,
    bus: new AgentBus(registry, async () => {}),
    box: undefined,
    fetchedHome: root,
    ...extra,
  } as unknown as ToolContext;
  return { root, registry, agent, context, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const page = (text: string, over?: Partial<Record<string, unknown>>) => ({
  url: "https://example.com/a",
  title: "A page",
  text,
  truncated: false,
  completeness: "full" as const,
  shape: { chars: text.length, prose: 1, links: 0 },
  fullText: text,
  contentType: "text/html",
  bytes: text.length * 2,
  meta: {},
  ...over,
});

test("WebFetch leads with the shape of what it got, and says how much there was when it cut", async () => {
  const whole = `${"a paragraph that is comfortably long enough to count as prose.".repeat(3)}`;
  const full = fixture({ webFetch: async () => page(whole) as never });
  try {
    const result = await dispatchTool("WebFetch", { url: "https://example.com/a" }, full.context);
    const parsed = parseReadOutcome(result.text);
    assert.equal(parsed?.completeness, "full");
    assert.match(result.text, new RegExp(`^\\[read: full — ${whole.length} chars, 1 prose blocks, 0 links\\]`));
    assert.match(result.text, /\n\n# A page\nSource: https:\/\/example\.com\/a/, "the body follows the line");
  } finally {
    full.cleanup();
  }

  const clipped = fixture({
    webFetch: async () =>
      page("shown part", { completeness: "clipped", truncated: true, shape: { chars: 61_606, prose: 57, links: 576 }, fullText: "x".repeat(61_606) }) as never,
  });
  try {
    const result = await dispatchTool("WebFetch", { url: "https://example.com/a" }, clipped.context);
    assert.equal(parseReadOutcome(result.text)?.completeness, "clipped");
    assert.match(result.text, /10 of 61,606 chars, 57 prose blocks, 576 links/);
    assert.match(result.text, /browser_open/, "and what to do about it");
  } finally {
    clipped.cleanup();
  }
});

test("a blocked page and an unreachable one are different words, both in the first line", async () => {
  const blocked = fixture({
    webFetch: async () => {
      throw new WebError("example.com did not serve the page — it answered with a block or consent screen.", "blocked");
    },
  });
  try {
    const result = await dispatchTool("WebFetch", { url: "https://example.com/a" }, blocked.context);
    assert.ok(result.isError);
    assert.equal(parseReadOutcome(result.text)?.completeness, "blocked");
    assert.match(result.text, /block or consent screen/);
  } finally {
    blocked.cleanup();
  }

  const gone = fixture({
    webFetch: async () => {
      throw new WebError("https://example.com/a returned HTTP 404.");
    },
  });
  try {
    const result = await dispatchTool("WebFetch", { url: "https://example.com/a" }, gone.context);
    assert.equal(parseReadOutcome(result.text)?.completeness, "unavailable");
  } finally {
    gone.cleanup();
  }
});

test("read_file counts lines, and a range read says how many of how many", async () => {
  const content = "one\ntwo\nthree";
  const box = {
    readFile: async () => ({ path: "/home/box/work/a.txt", content, total_lines: 3, truncated: false }),
  };
  const whole = fixture({ box: box as never });
  try {
    const result = await dispatchTool("read_file", { path: "/home/box/work/a.txt" }, whole.context);
    assert.match(result.text, /^\[read: full — 13 chars, 3 lines\]/);
    assert.match(result.text, /\n\n\/home\/box\/work\/a\.txt\n\none\ntwo\nthree$/);
  } finally {
    whole.cleanup();
  }

  const part = fixture({
    box: { readFile: async () => ({ path: "/home/box/work/big.txt", content, total_lines: 900, truncated: true }) } as never,
  });
  try {
    const result = await dispatchTool("read_file", { path: "/home/box/work/big.txt", start_line: 1, end_line: 3 }, part.context);
    assert.equal(parseReadOutcome(result.text)?.completeness, "clipped");
    assert.match(result.text, /3 of 900 lines/);
    assert.match(result.text, /line range/);
  } finally {
    part.cleanup();
  }
});

test("ReadHistory says how many entries it showed of how many matched, and that each one is cut", async () => {
  const { registry, agent, context, cleanup } = fixture();
  try {
    for (let n = 0; n < 40; n++) {
      registry.appendTranscript(agent.id, { role: "user", text: `message ${n} about widgets`, at: new Date(Date.UTC(2026, 8, 22, 0, n)).toISOString() });
    }
    const result = await dispatchTool("ReadHistory", { search: "widgets" }, context);
    const parsed = parseReadOutcome(result.text);
    assert.equal(parsed?.completeness, "clipped", result.text.slice(0, 120));
    assert.match(result.text, /25 of 40 entries/);
    assert.match(result.text, /each entry is cut to 600 chars/);
  } finally {
    cleanup();
  }
});

test("browser_read reports what came back, and says so plainly when nothing did", async () => {
  const prose = "The page says something long enough to be counted as a block of prose here.";
  const read = fixture({
    displayIndex: 1,
    box: { browser: async () => ({ url: "https://example.com/", text: prose, snapshot: "" }) } as never,
  });
  try {
    const result = await dispatchTool("browser_read", {}, read.context);
    assert.equal(parseReadOutcome(result.text)?.completeness, "full");
    assert.match(result.text, new RegExp(`${prose.length} chars, 1 prose blocks`));
    assert.match(result.text, /\n\nhttps:\/\/example\.com\/\n\nThe page says/);
  } finally {
    read.cleanup();
  }

  const empty = fixture({
    displayIndex: 1,
    box: { browser: async () => ({ url: "https://example.com/", snapshot: "" }) } as never,
  });
  try {
    const result = await dispatchTool("browser_read", {}, empty.context);
    assert.equal(parseReadOutcome(result.text)?.completeness, "unavailable");
    assert.match(result.text, /the page has no text/);
  } finally {
    empty.cleanup();
  }
});
