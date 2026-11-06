/**
 * The command table is what the parsers read (INV-1660): every alias the table lists is accepted
 * by the parser that dispatches it, so a word added to the table works, and a word a parser
 * accepted from a list of its own would have to be in the table to pass architecture-guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_COMMANDS,
  contextMode,
  isPlainRetry,
  parseAcceptance,
  parseApprovalReply,
  parseBoardRequest,
  parseDesktopRequest,
  parseDigestRequest,
  parseHelpRequest,
  parseRosterRequest,
  parseSchedulesRequest,
  parseScreenRequest,
  parseStopRequest,
  parseUpgradeApproval,
} from "./commands.ts";

const PARSERS: Record<string, (word: string, syntax: string) => unknown> = {
  new: word => contextMode(word),
  retry: word => isPlainRetry(word) || undefined,
  approve: word => parseApprovalReply(word),
  upgrade: word => parseUpgradeApproval(word) || undefined,
  board: word => parseBoardRequest(word) || undefined,
  roster: word => parseRosterRequest(word) || undefined,
  schedules: word => parseSchedulesRequest(word) || undefined,
  digest: word => parseDigestRequest(word),
  stop: word => parseStopRequest(word) || undefined,
  accept: word => parseAcceptance(word) || undefined,
  help: word => parseHelpRequest(word) || undefined,
  desktop: word => parseDesktopRequest(word) || undefined,
  screen: word => parseScreenRequest(word) || undefined,
};

test("every word in the command table is accepted by the parser that dispatches it", () => {
  for (const command of CHAT_COMMANDS) {
    for (const form of command.forms) {
      if (form.words === undefined) continue;
      const parse = PARSERS[command.key];
      assert.ok(parse !== undefined, `${command.key} lists words but no parser reads them`);
      for (const word of form.words) assert.notEqual(parse(word, form.syntax), undefined, `${command.key}: "${word}"`);
    }
  }
  // The four answers to a consent stay four: a word in the wrong form would approve the wrong way.
  assert.equal(parseApprovalReply("一直允许"), "always");
  assert.equal(parseApprovalReply("拒绝"), "deny");
  assert.equal(contextMode("/new --clean"), "clean");
});

test("every command says what it does in both languages and has a form to write it in", () => {
  const keys = new Set<string>();
  for (const command of CHAT_COMMANDS) {
    assert.ok(!keys.has(command.key), `${command.key} is listed twice`);
    keys.add(command.key);
    assert.ok(command.forms.length > 0, command.key);
    assert.ok(command.summary.zh.trim() !== "" && command.summary.en.trim() !== "", command.key);
  }
});
