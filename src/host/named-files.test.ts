/**
 * Tests for a reply that names a deliverable instead of handing it over.
 *
 * The report: an agent wrote its research to
 * `/home/box/work/skills/financial-statement-parsing/SKILL.md` and answered "the full
 * version is at «path»". A real file in the box; an unopenable string to the person
 * reading it in a chat, who had to ask again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { boxPathsNamed, undelivered } from "./named-files.ts";

const IMAGE = "/home/box/work";

test("the path from the report is found, in the prose it appeared in", () => {
  const reply =
    "调研完了，分四层给你——完整版在 `/home/box/work/skills/financial-statement-parsing/SKILL.md`，" +
    "下面是摘要。";
  assert.deepEqual(boxPathsNamed(reply, IMAGE), [
    "/home/box/work/skills/financial-statement-parsing/SKILL.md",
  ]);
});

test("prose punctuation is not part of the path", () => {
  // "…at /home/box/work/x.md, below is the summary" names x.md, not "x.md,".
  assert.deepEqual(boxPathsNamed("saved at /home/box/work/x.md, see below", IMAGE), [
    "/home/box/work/x.md",
  ]);
  assert.deepEqual(boxPathsNamed("see /home/box/work/notes/a.md.", IMAGE), ["/home/box/work/notes/a.md"]);
  assert.deepEqual(boxPathsNamed('wrote "/home/box/work/b.csv" for you', IMAGE), ["/home/box/work/b.csv"]);
});

test("a directory is not a deliverable", () => {
  // Naming where things live is ordinary and must not trigger a send.
  assert.deepEqual(boxPathsNamed("your files are under /home/box/work/chats/x/outbox", IMAGE), []);
  assert.deepEqual(boxPathsNamed("the work directory is /home/box/work", IMAGE), []);
});

test("paths outside the work directory are not ours to send", () => {
  assert.deepEqual(boxPathsNamed("check /etc/passwd and /home/box/.config/gh/hosts.yml", IMAGE), []);
});

test("the same document is not sent twice under two paths", () => {
  // The ordinary good case: the agent wrote it somewhere of its own *and* copied it to
  // the outbox. Comparing by name rather than path is what stops the duplicate.
  assert.deepEqual(
    undelivered(["/home/box/work/report.md"], ["report.md"]),
    [],
    "already delivered from the outbox"
  );
  assert.deepEqual(undelivered(["/home/box/work/report.md"], ["other.md"]), [
    "/home/box/work/report.md",
  ]);
});

test("each path is offered once however many times the reply says it", () => {
  const reply = "at /home/box/work/a.md — again, /home/box/work/a.md — and /home/box/work/b.md";
  assert.deepEqual(boxPathsNamed(reply, IMAGE), ["/home/box/work/a.md", "/home/box/work/b.md"]);
});

test("on a host box the paths are its own work directory's, and the image's name nothing there (INV-1737)", () => {
  const work = "/Users/ada/lumen.box";
  assert.deepEqual(boxPathsNamed(`完整版在 \`${work}/reports/q3.md\`，下面是摘要；also /home/box/work/x.md and /Users/ada/lumenXbox/y.md`, work), [`${work}/reports/q3.md`]);
});
