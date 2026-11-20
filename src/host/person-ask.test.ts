/** A member's request to the person read back out of its note (INV-1923): the card, the inbox row and the chat all depend on this reading. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASK_KINDS, ASK_SENTENCES, PERSON_ASK_RULE, askLabel, askLines, askProse, askOf, splitAsk } from "./person-ask.ts";
import { parseDelivery } from "./delivery-report.ts";
import { TaskStore } from "./tasks.ts";

const ASK = [
  "请你做：登录供应商后台，下载十月发票",
  "发生了什么：对账到第 3 步，后台要短信验证码。",
  "为什么是你：验证码只发到你的手机。",
  "怎么做：打开 https://vendor.example/login ，登录后把 PDF 放进 inbox/。",
  "我同时在做：九月和八月的对账，不受影响。",
  "仍归你检查：发票抬头是否是新公司名。",
].join("\n");

test("a note that opens with the action reads as a request: what is in the way, the title, the sentences in order", () => {
  const { ask, rest } = splitAsk(ASK);
  assert.equal(ask?.kind, "act");
  assert.equal(ask?.title, "登录供应商后台，下载十月发票");
  assert.deepEqual(ask?.said.map(row => row.key), [...ASK_SENTENCES]);
  assert.equal(ask?.said.find(row => row.key === "meanwhile")?.text, "九月和八月的对账，不受影响。");
  assert.equal(ask?.lang, "zh");
  assert.equal(rest, "", "nothing else was written");

  // Dressed as a member dresses it, out of order, with prose around it: the prose stays the note's.
  const en = splitAsk("I got as far as the send step.\n\n**Please approve:** Send the renewal notice to 214 customers\n- Meanwhile: drafting the follow-up.\n- Why you: it goes out under your name.\nMeanwhile: said twice.");
  assert.deepEqual([en.ask?.kind, en.ask?.title, en.ask?.lang], ["approve", "Send the renewal notice to 214 customers", "en"]);
  assert.deepEqual(en.ask?.said, [{ key: "why", text: "it goes out under your name." }, { key: "meanwhile", text: "drafting the follow-up." }]);
  assert.equal(en.rest, "I got as far as the send step.\n\nMeanwhile: said twice.", "what is not the request is left as it was written");
});

test("a note without the action line is not a request, and is left whole", () => {
  for (const note of ["", "Blocked: the vendor site is down.", "Meanwhile: I will keep going.\nWhy you: nobody else can.", "Please do:", "```\nPlease do: x\n```"]) {
    assert.deepEqual(splitAsk(note), { rest: note }, JSON.stringify(note));
  }
  assert.deepEqual(splitAsk(undefined), { rest: "" });
});

test("every name can be read back as it is asked for, the prompt asks for all of them, and a chat is sent the same lines", () => {
  for (const lang of ["en", "zh"] as const) {
    for (const kind of ASK_KINDS) assert.equal(splitAsk(`${askLabel(kind, lang)}: x`).ask?.kind, kind, askLabel(kind, lang));
    for (const key of ASK_SENTENCES) assert.deepEqual(splitAsk(`${askLabel("act", lang)}: x\n${askLabel(key, lang)}: y`).ask?.said, [{ key, text: "y" }], askLabel(key, lang));
    for (const key of [...ASK_KINDS, ...ASK_SENTENCES]) assert.ok(PERSON_ASK_RULE.includes(askLabel(key, lang)), `the rule names ${askLabel(key, lang)}`);
  }
  assert.match(PERSON_ASK_RULE, /keep doing whatever else does not need them/, "waiting on a person is not stopping");
  // What a person reads first, on the card and in a chat alike: the action, the sentences as one running paragraph without
  // the names they were written under, and apart from it what stays theirs to check. The names are the member's format.
  assert.deepEqual(askLines(splitAsk(ASK).ask!), [
    "请你做：登录供应商后台，下载十月发票",
    "对账到第 3 步，后台要短信验证码。验证码只发到你的手机。打开 https://vendor.example/login ，登录后把 PDF 放进 inbox/。我同时在做：九月和八月的对账，不受影响。",
    "仍归你检查：发票抬头是否是新公司名。",
  ]);
  const open = splitAsk("Please do: Rotate the key\nWhat happened: The key expired\nHow: Open the vault; rotate it:\nMeanwhile: reviewing the logs").ask!;
  assert.deepEqual(askProse(open), { text: "The key expired. Open the vault; rotate it: Meanwhile: reviewing the logs." }, "a sentence left open is closed, so two do not run into one; nothing to check is no line");
  for (const lang of ["en", "zh"] as const) assert.ok(askProse({ lang, said: [{ key: "meanwhile", text: "x" }] }).text.startsWith(askLabel("meanwhile", lang)), "the one name kept in line is the name it is written under");
  assert.deepEqual(askLines(splitAsk("Please approve: Send it").ask!), ["Please approve: Send it"], "a title alone is a request");
});

test("a delivery that also asks is read as both: the request is no part of the delivery", () => {
  const note = "请你确认：看一眼夏令时分支再上线\n导出现在保留账号的时区。\n主要改动：src/export.ts 第 41 行。\n我同时在做：补导入那边的同一个问题。\n未做与局限：线上账号没有验证\n下一步：你确认后我发版。";
  assert.deepEqual(parseDelivery(note)?.parts.map(part => [part.key, part.text]), [["result", "导出现在保留账号的时区。"], ["main", "src/export.ts 第 41 行。"], ["limits", "线上账号没有验证"], ["next", "你确认后我发版。"]]);
  assert.deepEqual(splitAsk(note).ask, { kind: "check", title: "看一眼夏令时分支再上线", said: [{ key: "meanwhile", text: "补导入那边的同一个问题。" }], lang: "zh" });
});

test("a task carries a request while it waits on a person, and only the member doing the work asks", () => {
  const board = new TaskStore(null);
  const task = board.create({ title: "Reconcile October", requester: "feishu:ou_1", assigneeId: "mia" })!;
  assert.equal(askOf(board.get(task.id)!), undefined, "nothing asked yet");
  board.update(task.id, { status: "blocked", note: ASK }, "mia");
  assert.equal(askOf(board.get(task.id)!)?.title, "登录供应商后台，下载十月发票");
  board.update(task.id, { note: "还在等" }, "mia");
  assert.equal(askOf(board.get(task.id)!)?.title, "登录供应商后台，下载十月发票", "a later remark does not withdraw it");
  board.update(task.id, { status: "doing", note: "我做完了" }, "feishu:ou_1");
  assert.equal(askOf(board.get(task.id)!), undefined, "answered: the request is over");
  board.update(task.id, { status: "blocked", note: "Please do: x" }, "feishu:ou_1");
  assert.equal(askOf(board.get(task.id)!), undefined, "somebody else parking the task is not the member asking");
});
