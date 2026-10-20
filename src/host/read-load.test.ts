import { test } from "node:test";
import assert from "node:assert/strict";
import { READ_LOAD_CHARS, READ_LOAD_SHARE, isReadTool, readLoadCrossed, readLoadNudge, readLoadNudgeDue } from "./read-load.ts";

test("the read-load signal: what crosses, who is told, and what the note says (INV-1222)", () => {
  const quiet = { chars: 10_000, toolRounds: 2, share: 0.2, reading: true };
  const heavy = { chars: READ_LOAD_CHARS + 1, toolRounds: 3, share: 0.3, reading: false };
  const nearFull = { chars: 20_000, toolRounds: 9, share: READ_LOAD_SHARE + 0.05, reading: true };
  const nearFullWorking = { ...nearFull, reading: false };
  assert.equal(readLoadCrossed(quiet), false);
  assert.equal(readLoadCrossed(heavy), true, "a lot of results is a lot however it got there");
  assert.equal(readLoadCrossed(nearFull), true, "most of the way to compaction and still reading");
  assert.equal(readLoadCrossed(nearFullWorking), false, "a full context doing work is not reading");
  const plain = { nudged: false, fork: false, goal: false };
  assert.equal(readLoadNudgeDue(heavy, plain), true);
  assert.equal(readLoadNudgeDue(heavy, { ...plain, nudged: true }), false, "once per turn");
  assert.equal(readLoadNudgeDue(heavy, { ...plain, fork: true }), false, "a fork is meant to be heavy");
  assert.equal(readLoadNudgeDue(heavy, { ...plain, goal: true }), false, "the goal loop paces itself");
  assert.equal(isReadTool("read_file"), true);
  assert.equal(isReadTool("bash"), false);
  assert.match(readLoadNudge(heavy, false), /^\[host\] This turn has read about 120k characters .* \(3 tool rounds\); the context is at about 30%/);
  assert.match(readLoadNudge(heavy, true), /^\[宿主提示\] .*120k 字符.*3 轮工具调用.*30%/);
});
