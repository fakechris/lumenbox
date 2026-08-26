/**
 * Tests for answering about a `.env`'s shape instead of its contents.
 *
 * The property under test is narrow and worth stating plainly: **no value ever appears in
 * the output.** This is a helper, not a control — `bash` reads the same file — so what it
 * has to get right is not preventing access but not leaking on the path it does serve.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeEnvShape, envShape, looksLikeEnvFile } from "./env-shape.ts";

const SAMPLE = [
  "# database",
  "DATABASE_URL=postgres://user:hunter2@localhost/app",
  "",
  'API_KEY="sk-realvalue0123456789"',
  "export DEBUG=1",
  "EMPTY=",
  "not a definition at all",
].join("\n");

test("the shape names every variable and no value", () => {
  const shape = envShape(SAMPLE);
  assert.deepEqual(
    shape.keys.map(key => key.name),
    ["DATABASE_URL", "API_KEY", "DEBUG", "EMPTY"],
    "`export FOO=` counts, and so does an empty one"
  );
  const text = describeEnvShape("/home/box/work/.env", shape);
  for (const secret of ["hunter2", "sk-realvalue0123456789", "postgres://"]) {
    assert.ok(!text.includes(secret), `the output must not contain ${secret}`);
  }
  assert.match(text, /DATABASE_URL/);
  assert.match(text, /EMPTY {2}\(set to empty\)/, "set-to-empty is answerable without the value");
});

test("quotes are syntax, not value", () => {
  // `FOO=""` is empty and `FOO="x"` is one character; counting the quotes would report
  // both wrong and would be the sort of small lie that makes a tool untrustworthy.
  const shape = envShape('A=""\nB="x"\nC=x');
  assert.deepEqual(
    shape.keys.map(key => [key.name, key.empty, key.valueChars]),
    [
      ["A", true, 0],
      ["B", false, 1],
      ["C", false, 1],
    ]
  );
});

test("comments and noise are counted, not described", () => {
  const shape = envShape("# a\n\nnonsense line\nFOO=bar");
  assert.equal(shape.otherLines, 3);
  assert.equal(shape.keys.length, 1);
  assert.match(describeEnvShape("/x/.env", envShape("# only a comment")), /defines no variables/);
});

test("only .env-shaped names take this path", () => {
  for (const path of ["/a/.env", "/a/.env.local", "/a/.env.production"]) {
    assert.ok(looksLikeEnvFile(path), `${path} should be treated as a .env`);
  }
  for (const path of ["/a/env", "/a/environment.md", "/a/.environment", "/a/notes.env.md"]) {
    assert.ok(!looksLikeEnvFile(path), `${path} is an ordinary file`);
  }
});
