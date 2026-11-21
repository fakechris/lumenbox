import assert from "node:assert/strict";
import { test } from "node:test";
import { approvedCallNotice } from "./approval-notice.ts";

test("a granted, unexecuted call names the scope and tells the member to retry", () => {
  for (const [scope, duration] of [["once", "once"], ["session", "for this session"], ["always", "until revoked"]] as const) {
    for (const description of ["bash: echo hi", ""]) {
      const notice = approvedCallNotice(description, scope);
      assert.ok(notice.includes(duration));
      assert.ok(notice.includes(description));
      assert.match(notice, /NOT executed/);
      assert.match(notice, /same call again now/);
      assert.match(notice, /without asking again/);
    }
  }
});
