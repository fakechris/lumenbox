/**
 * Tests for the batch progress convention.
 *
 * The property that matters: a card never shows a number that is not really in the file.
 * A torn write, prose, or impossible figures are all "no update", never a guess.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProgressFile, progressLine } from "./progress-file.ts";

test("a whole sane file becomes the person's progress line", () => {
  assert.equal(progressLine(parseProgressFile('{"current":37,"total":300}')!), "已处理 37/300");
  assert.equal(
    progressLine(parseProgressFile('{"current":299,"total":300,"failed":["q1.pdf","q7.pdf"]}')!),
    "已处理 299/300,2 份有问题"
  );
});

test("anything less than a whole sane file is no update, not a guess", () => {
  // The poller reads while the script writes: a torn JSON tail is the ordinary case.
  assert.equal(parseProgressFile('{"current":37,"tot'), undefined);
  // A script that wrote prose instead of the record.
  assert.equal(parseProgressFile("processing q37.pdf..."), undefined);
  // Impossible figures. 301/300 on a card reads as the system lying, which costs more
  // than the update is worth.
  assert.equal(parseProgressFile('{"current":301,"total":300}'), undefined);
  assert.equal(parseProgressFile('{"current":-1,"total":300}'), undefined);
  assert.equal(parseProgressFile('{"current":1,"total":0}'), undefined);
  assert.equal(parseProgressFile('{"current":"37","total":300}'), undefined);
  assert.equal(parseProgressFile("null"), undefined);
});

test("an empty failed list is not worth a clause", () => {
  assert.equal(
    progressLine(parseProgressFile('{"current":5,"total":10,"failed":[]}')!),
    "已处理 5/10"
  );
});
