/**
 * The audit export against a scripted home: two boxes' worth of ledgers, one box asked for,
 * one window — what comes out is that box's, inside the window, with the secrets gone, and
 * it reads back to the same records.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { attachedBox } from "../box/boxes.ts";
import { describeExport, exportAudit, heldValues, readAuditExport, redactLine } from "./audit-export.ts";

const SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab";
const PASSWORD = "hunter2-very-long-password";

function home(): { root: string; registry: AgentRegistry; ada: string; bob: string; grokId: string } {
  const root = mkdtempSync(join(tmpdir(), "agentbox-audit-export-"));
  const registry = new AgentRegistry(join(root, "agents"));
  const tokenFile = join(root, "grok.token");
  writeFileSync(tokenFile, "tok\n");
  const grok = registry.attachBox(attachedBox({ name: "grok", baseUrl: "http://127.0.0.1:13370/", tokenFile }));
  const ada = registry.create({ name: "Ada", boxId: registry.box.id }).id;
  const bob = registry.create({ name: "Bob", boxId: grok.id }).id;
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  writeFileSync(join(root, "usage.jsonl"), [
    line({ seq: 1, at: "2026-09-10T10:00:00Z", agentId: ada, agentName: "Ada", inputTokens: 10 }),
    line({ seq: 2, at: "2026-09-10T11:00:00Z", agentId: bob, agentName: "Bob", inputTokens: 20 }),
    line({ seq: 3, at: "2026-08-01T11:00:00Z", agentId: ada, agentName: "Ada", inputTokens: 30 }),
    line({ seq: 4, agentId: ada, agentName: "Ada", inputTokens: 40 }),
  ].join(""));
  writeFileSync(join(root, "auto-review.jsonl"), line({ at: "2026-09-10T10:01:00Z", agent: "Ada", tool: "bash", verdict: "ALLOW", reason: `curl -H 'Authorization: Bearer ${SECRET}'` }));
  writeFileSync(join(root, "vault-audit.jsonl"), line({ at: "2026-09-10T10:02:00Z", secretId: "SHOP_PASSWORD", agentId: ada, allowed: true }) + line({ at: "2026-09-10T10:02:00Z", secretId: "X", agentId: bob, allowed: false }));
  writeFileSync(join(root, "network-events.jsonl"), line({ at: "2026-09-10T10:03:00Z", box: registry.box.id, host: "api.github.com", port: 443, allowed: true }) + line({ at: "2026-09-10T10:03:00Z", box: grok.id, host: "x.test", port: 443, allowed: false }));
  writeFileSync(join(root, "turns.jsonl"), line({ id: "t1", event: "begin", agentId: ada, at: "2026-09-10T10:00:00Z", attempt: 1 }));
  writeFileSync(join(root, "vault.json"), JSON.stringify({ secrets: [{ id: "SHOP_PASSWORD", value: PASSWORD, grants: [] }, { id: "short", value: "abc", grants: [] }] }));
  writeFileSync(join(root, "config.json"), JSON.stringify({ channels: { feishu: { appSecret: "feishu-app-secret-value-1" } } }));
  registry.appendTranscript(ada, { role: "user", text: `the password is ${PASSWORD}`, at: "2026-09-10T10:00:00Z" });
  registry.appendTranscript(ada, { role: "assistant", text: "noted", at: "2026-09-10T10:00:05Z" });
  registry.appendTranscript(ada, { role: "user", text: "old", at: "2026-01-01T00:00:00Z" });
  registry.appendTranscript(ada, { role: "user", text: "side work", at: "2026-09-10T12:00:00Z" }, "side-1");
  registry.appendTranscript(bob, { role: "user", text: "bob's", at: "2026-09-10T10:00:00Z" });
  return { root, registry, ada, bob, grokId: grok.id };
}

test("an export is one box's ledgers inside the window, secrets redacted, and reads back to the same records", () => {
  const { root, registry, ada, grokId } = home();
  try {
    const out = join(root, "export");
    const held = heldValues(root);
    assert.deepEqual([...held.keys()].sort(), ["config.channels.feishu.appSecret", "vault:SHOP_PASSWORD", "vault:short"]);
    const manifest = exportAudit({ home: root, registry, box: registry.box.name, from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z", out, held, now: () => new Date("2026-09-11T00:00:00Z") });
    assert.equal(manifest.box.id, registry.box.id);
    assert.deepEqual(manifest.agents, [{ id: ada, name: "Ada" }]);
    assert.equal(manifest.files["usage.jsonl"], 1, "Bob's, August's and the undated line are out");
    assert.equal(manifest.undated, 1);
    assert.equal(manifest.files["auto-review.jsonl"], 1);
    assert.equal(manifest.files["vault-audit.jsonl"], 1);
    assert.equal(manifest.files["network-events.jsonl"], 1);
    assert.equal(manifest.files["turns.jsonl"], 1);
    assert.equal(manifest.files[join("transcripts", ada, "main.jsonl")], 2);
    assert.equal(manifest.files[join("transcripts", ada, "side-1.jsonl")], 1);
    assert.deepEqual(manifest.redactions, { exact: 1, pattern: 1 });

    const everything = Object.keys(manifest.files).map(file => readFileSync(join(out, file), "utf8")).join("");
    assert.doesNotMatch(everything, new RegExp(PASSWORD));
    assert.doesNotMatch(everything, new RegExp(SECRET));
    assert.match(everything, /<redacted:vault:SHOP_PASSWORD>/);
    assert.match(everything, /Bearer <redacted:/);
    assert.doesNotMatch(everything, /bob's|Bob/);

    const back = readAuditExport(out);
    assert.equal(back.manifest.generatedAt, "2026-09-11T00:00:00.000Z");
    assert.equal(back.records["usage.jsonl"]?.[0]?.seq, 1);
    assert.equal(back.records[join("transcripts", ada, "main.jsonl")]?.[1]?.text, "noted");
    const report = describeExport(manifest, out);
    assert.match(report[0]!, /^Audit export for box/);
    assert.ok(report.some(l => /redacted: 1 held value\(s\), 1 credential-shaped/.test(l)));
    assert.ok(report.some(l => /1 line\(s\) had no readable time/.test(l)));

    // The other box, by id: only Bob's.
    const other = exportAudit({ home: root, registry, box: grokId, from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z", out: join(root, "export-grok"), held });
    assert.deepEqual(other.agents.map(a => a.name), ["Bob"]);
    assert.equal(other.files["usage.jsonl"], 1);
    assert.equal(other.files["network-events.jsonl"], 1);
    assert.equal(other.files["vault-audit.jsonl"], 1);
    assert.throws(() => exportAudit({ home: root, registry, box: "nowhere", from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z", out: join(root, "x") }), /no box nowhere; known: /);
    assert.throws(() => exportAudit({ home: root, registry, box: grokId, from: "2026-09-30T00:00:00Z", to: "2026-09-01T00:00:00Z", out: join(root, "x") }), /not two instants in order/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("redaction replaces every copy of a held value and every credential-shaped string, and leaves short values alone", () => {
  const held = new Map([["vault:K", "0123456789abcdef"], ["vault:short", "admin"]]);
  const r = redactLine('{"a":"0123456789abcdef","b":"0123456789abcdef admin"}', held);
  assert.equal(r.text, '{"a":"<redacted:vault:K>","b":"<redacted:vault:K> admin"}');
  assert.equal(r.exact, 2);
  assert.equal(r.pattern, 0);
});

test("fetched pages inside the window travel with the export, redacted, and are listed apart from the ledgers", async () => {
  const { keepFetchedPage } = await import("./fetched.ts");
  const { mkdirSync } = await import("node:fs");
  const { root, registry, ada, bob } = home();
  try {
    const page = (agent: { id: string; name: string }, at: string, text: string) =>
      keepFetchedPage(
        { url: `https://example.com/${at}`, finalUrl: `https://example.com/${at}`, text, contentType: "text/html", bytes: 1, clipped: false, meta: {}, agent, fetchedAt: new Date(at) },
        root
      );
    page({ id: ada, name: "Ada" }, "2026-09-10T10:05:00.000Z", `the page quoted the password ${PASSWORD} in full`);
    page({ id: ada, name: "Ada" }, "2026-01-01T00:00:00.000Z", "old page");
    page({ id: bob, name: "Bob" }, "2026-09-10T10:06:00.000Z", "bob's page, another box");
    // A kept X post names no agent and is taken by time alone.
    const xDir = join(root, "fetched", "x", "123");
    mkdirSync(xDir, { recursive: true });
    writeFileSync(join(xDir, "post.md"), "---\nfetched_at: 2026-09-10T10:07:00.000Z\n---\n\npost body\n");
    writeFileSync(join(xDir, "fxtwitter-v2.json"), "{}");

    const out = join(root, "export");
    const manifest = exportAudit({ home: root, registry, box: registry.box.name, from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z", out, held: heldValues(root), now: () => new Date("2026-09-11T00:00:00Z") });
    const fetched = Object.keys(manifest.fetched ?? {}).sort();
    assert.equal(fetched.length, 2, JSON.stringify(fetched));
    assert.ok(fetched.some(f => f.startsWith("fetched/2026-09/")), "Ada's page in the window");
    assert.ok(fetched.includes("fetched/x/123/post.md"), "the X post by time");
    const exported = readFileSync(join(out, fetched.find(f => f.startsWith("fetched/2026-09/"))!), "utf8");
    assert.ok(!exported.includes(PASSWORD), "the held value is gone");
    assert.match(exported, /<redacted:vault:SHOP_PASSWORD>/);
    assert.ok(!Object.keys(manifest.files).some(f => f.startsWith("fetched/")), "prose is not listed as a ledger");
    // And the ledger reader still reads the export back without choking on markdown.
    const back = readAuditExport(out);
    assert.equal(back.manifest.fetched?.["fetched/x/123/post.md"], Buffer.byteLength("---\nfetched_at: 2026-09-10T10:07:00.000Z\n---\n\npost body\n", "utf8"));
    assert.ok(describeExport(manifest, out).some(line => /fetched pages: 2 file\(s\)/.test(line)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

