/** The corpus: what a task must say, what keeps dev and test apart, and that the files match their sources (INV-1772). */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Corpus, corpusProblems, corpusVersion, type EvalTask, loadCorpus, serializeCorpus, taskProblem, taskVersion } from "./corpus.ts";
import { buildCorpus, DERIVED_KINDS } from "./corpus-build.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const task = (id: string, more: Partial<EvalTask> = {}): EvalTask => ({
  id, subject: "steward", source: { kind: "steward-tail", ref: `x#${id}` }, failureType: "missed-stopping-point",
  input: { condensed: 0, view: `them: ${id}` }, gold: { labels: { all: ["switch"] } }, ...more,
});

test("a task says where it came from, which failure it catches and how it is graded, or it is refused", () => {
  assert.equal(taskProblem(task("a")), undefined);
  assert.match(taskProblem({ ...task("a"), gold: {} })!, /a task nothing grades proves nothing/);
  assert.match(taskProblem({ ...task("a"), gold: { answer: "only a reference" } })!, /nothing grades/, "a reference answer alone is not a grader");
  assert.match(taskProblem({ ...task("a"), failureType: " " })!, /failureType/);
  assert.match(taskProblem({ ...task("a"), source: { kind: "elsewhere", ref: "x" } })!, /source needs a kind/);
  assert.match(taskProblem({ ...task("a"), subject: "chat" })!, /subject must be one of/);
  assert.match(taskProblem(task("Has Spaces"))!, /id must be/);
});

test("dev and test stay apart: the same id, the same input or one group on both sides is refused at load", () => {
  const corpus = (dev: EvalTask[], test: EvalTask[]): Corpus => ({ dev, test });
  assert.deepEqual(corpusProblems(corpus([task("a")], [task("b")])), []);
  assert.match(corpusProblems(corpus([task("a")], [task("a")]))[0]!, /a appears in both dev and test/);
  assert.match(corpusProblems(corpus([task("a"), task("a")], []))[0]!, /twice in dev/);
  const sameInput = corpusProblems(corpus([task("a")], [task("b", { input: task("a").input })]));
  assert.match(sameInput[0]!, /same input as a \(dev\)/, "the same question under another id is still the same question");
  assert.match(corpusProblems(corpus([task("a", { group: "g" })], [task("b", { group: "g" })]))[0]!, /group g is split/);

  const dir = mkdtempSync(join(tmpdir(), "inv1772-corpus-"));
  try {
    writeFileSync(join(dir, "dev.jsonl"), serializeCorpus([task("a")]));
    writeFileSync(join(dir, "test.jsonl"), serializeCorpus([task("a")]));
    assert.throws(() => loadCorpus(dir), /in both dev and test/);
    writeFileSync(join(dir, "test.jsonl"), `${JSON.stringify({ ...task("b"), gold: {} })}\n`);
    assert.throws(() => loadCorpus(dir), /test\.jsonl:1: gold needs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a version follows the content: an edited task is a different task, a reordered corpus is the same corpus", () => {
  assert.notEqual(taskVersion(task("a")), taskVersion(task("a", { gold: { labels: { all: ["compact"] } } })));
  assert.equal(taskVersion(task("a")), taskVersion(JSON.parse(JSON.stringify(task("a"))) as EvalTask));
  assert.equal(corpusVersion([task("a"), task("b")]), corpusVersion([task("b"), task("a")]));
});

test("the corpus in the repository is what its sources yield, with both halves present and every derived source represented", () => {
  const committed = loadCorpus(join(root, "evals/corpus"));
  const built = buildCorpus(root, committed);
  for (const split of ["dev", "test"] as const) {
    assert.equal(
      serializeCorpus(committed[split]), serializeCorpus(built[split]),
      `evals/corpus/${split}.jsonl no longer matches the cases it was derived from; run \`npm run eval -- build-corpus\` and commit the result`
    );
  }
  assert.ok(committed.dev.length >= 15 && committed.test.length >= 60, `dev ${committed.dev.length}, test ${committed.test.length}: too few to read a rate from`);
  const kinds = new Set([...committed.dev, ...committed.test].map(one => one.source.kind));
  for (const kind of DERIVED_KINDS) assert.ok(kinds.has(kind), `no task from ${kind}`);
});

test("a task keeps its side when the corpus is rebuilt, a person's own line is carried through, and one request shared by two skills is not split", () => {
  const fresh = buildCorpus(root);
  // Everything derived, moved to the other side: a rebuild must leave it there rather than re-deal it.
  const swapped = buildCorpus(root, { dev: fresh.test, test: fresh.dev });
  assert.deepEqual(swapped.dev.map(one => one.id).sort(), fresh.test.map(one => one.id).sort());
  const mine = task("mine.corrected-reply", { source: { kind: "review-ledger", ref: "message 123" }, subject: "episode", input: { says: "hello" }, gold: { facts: ["hello"] } });
  const kept = buildCorpus(root, { dev: [], test: [mine] });
  assert.ok(kept.test.some(one => one.id === mine.id), "a line this file does not derive is not dropped");
  assert.deepEqual(corpusProblems(fresh), [], "the same line is one skill's trigger and its neighbour's no-trigger: both land on one side");
});
