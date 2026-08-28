/**
 * Tests for the board as a chat reads it.
 *
 * The claims that matter: every id shown is a real task in this chat's list (no
 * invention — it is all lookups), grouping follows what a person does about a state,
 * display titles are clamped so a pre-rewrite paragraph-title cannot wall the message,
 * and a blocked landing speaks exactly once-shaped: never for the channel's own
 * failure path, which already told the chat.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedAnnouncement, boardText, boardView, BOARD_EMPTY } from "./board-view.ts";
import type { Task, TaskStatus } from "../host/tasks.ts";

function task(
  id: string,
  status: TaskStatus,
  title: string,
  extra: Partial<Task> = {}
): Task {
  const at = extra.updatedAt ?? "2026-08-27T08:00:00.000Z";
  return {
    id,
    title,
    status,
    requester: "chris",
    createdAt: at,
    updatedAt: at,
    history: [{ at, by: extra.assigneeId ?? "chris", status }],
    ...extra,
  };
}

const NOW = new Date("2026-08-27T12:00:00.000Z");
const noUrl = (): string | undefined => undefined;

test("live tasks group by what a person does about them, in triage order", () => {
  const view = boardView(
    [
      task("t3", "doing", "批量转换 PDF", { assigneeId: "agent-ada" }),
      task("t1", "review", "整理 Q3 报表", { assigneeId: "agent-ada" }),
      task("t2", "blocked", "抓取竞品价格", { assigneeId: "agent-bob" }),
      task("t4", "open", "翻译新闻稿"),
    ],
    (id: string) => (id === "agent-ada" ? "Ada" : "Bob"),
    noUrl,
    NOW
  );
  assert.equal(
    boardText(view),
    [
      "看板 · 4 件在办",
      "待验收:",
      "  t1 @Ada 整理 Q3 报表",
      "卡住了:",
      "  t2 @Bob 抓取竞品价格",
      "进行中:",
      "  t3 @Ada 批量转换 PDF",
      "排队中:",
      "  t4 翻译新闻稿",
    ].join("\n")
  );
});

test("a paragraph-length title is clamped: the board tells tasks apart, the full words are a click away", () => {
  const view = boardView(
    [
      task(
        "t60",
        "done",
        "要做啊!你从这个二维码(FoloToy),你能够找到它是一个什么样的项目?它有一个开源的GitHub项目,你找找",
        { updatedAt: "2026-08-27T09:00:00.000Z" }
      ),
    ],
    () => "Ada",
    noUrl,
    NOW
  );
  const line = view.done[0]!;
  assert.equal(line.title.length, 24);
  assert.match(line.title, /…$/);
});

test("recent finishes get one compact line; old ones and dropped work do not appear", () => {
  const view = boardView(
    [
      task("t1", "doing", "在办的", { assigneeId: "agent-ada" }),
      task("t2", "done", "刚完成的", { updatedAt: "2026-08-27T09:00:00.000Z" }),
      task("t3", "done", "上周完成的", { updatedAt: "2026-08-19T09:00:00.000Z" }),
      task("t4", "dropped", "放弃的"),
    ],
    () => "Ada",
    noUrl,
    NOW
  );
  const message = boardText(view);
  assert.match(message, /近 24 小时完成:t2 刚完成的/);
  assert.doesNotMatch(message, /t3|t4/);
});

test("a link rides on the line when the installation is reachable", () => {
  const view = boardView(
    [task("t1", "doing", "报表", { assigneeId: "agent-ada" })],
    () => "Ada",
    (id: string) => `https://box.example/?task=${id}`,
    NOW
  );
  assert.equal(view.groups[0]!.tasks[0]!.url, "https://box.example/?task=t1");
  assert.match(boardText(view), /t1 @Ada 报表 https:\/\/box\.example\/\?task=t1/);
});

test("an empty board says so instead of sending headings over nothing", () => {
  assert.equal(boardText(boardView([], () => "x", noUrl, NOW)), BOARD_EMPTY);
  // Only stale finishes is also an empty board: nothing to triage, nothing recent.
  assert.equal(
    boardText(
      boardView(
        [task("t9", "done", "老任务", { updatedAt: "2026-08-01T00:00:00.000Z" })],
        () => "x",
        noUrl,
        NOW
      )
    ),
    BOARD_EMPTY
  );
});

test("a blocked landing chosen by the agent speaks, with its note", () => {
  const parked = task("t5", "blocked", "抓取竞品价格", {
    history: [{ at: "2026-08-27T08:00:00.000Z", by: "agent-bob", status: "blocked", note: "要登录后台" }],
  });
  assert.equal(blockedAnnouncement(parked), "t5「抓取竞品价格」卡住了,要人来搭把手:要登录后台");
  const wordless = task("t6", "blocked", "抓取竞品价格", {
    history: [{ at: "2026-08-27T08:00:00.000Z", by: "agent-bob", status: "blocked" }],
  });
  assert.equal(blockedAnnouncement(wordless), "t6「抓取竞品价格」卡住了,要人来搭把手。");
});

test("the channel's own failure landing stays silent — the chat was already told", () => {
  const failed = task("t7", "blocked", "报表", {
    history: [
      { at: "2026-08-27T08:00:00.000Z", by: "channel", status: "blocked", note: "failed: box on fire" },
    ],
  });
  assert.equal(blockedAnnouncement(failed), undefined);
  // And a task in any other status is never an announcement.
  assert.equal(blockedAnnouncement(task("t8", "doing", "x")), undefined);
});
