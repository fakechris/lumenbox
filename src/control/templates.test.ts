/**
 * Share links on the control plane: the parent-and-versions model, who may do what with a box
 * token, what the public page shows and hides, and that a document never rides a page.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlStore, type BoxRow, mintShareId } from "./store.ts";
import { handleTemplateApi, renderSharePage, sharePageIdOf, shareUrl, templateRouteOf } from "./templates.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-tpl-control-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  const tenantA = store.upsertTenant({ name: "acme" });
  const tenantB = store.upsertTenant({ name: "other" });
  const box = (id: string, tenantId: string): BoxRow => {
    const row: BoxRow = {
      id,
      tenantId,
      allocatorKind: "compose",
      externalId: `agentbox-${id}`,
      boxdUrl: `http://${id}:1337`,
      uiUrl: `http://${id}:7777`,
      state: "ready",
      image: "img",
      createdAt: "2026-09-02T00:00:00Z",
      lastSeenAt: undefined,
      usageCursor: 0,
      role: "primary",
    };
    store.createBox(row, { box: `box-token-${id}`, ui: `ui-${id}` });
    return row;
  };
  const boxA = box("box-a", tenantA.id);
  const boxB = box("box-b", tenantB.id);
  // A second box in tenant A, as a caller only: the store allows one live box per tenant, and
  // what the handler checks is the row it is handed.
  const boxA2: BoxRow = { ...boxA, id: "box-a2" };
  return {
    store,
    tenantA,
    tenantB,
    boxA,
    boxA2,
    boxB,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const DOCUMENT = JSON.stringify({
  format: "lumenbox-template/1",
  profile: { name: "下载专家", description: "Turns videos into transcripts.", avatarColor: "brown" },
  memory: [],
  skills: [],
  routines: [],
  connectors: [],
});

test("routes: the control plane claims its own template shapes and nothing of the box's", () => {
  assert.deepEqual(templateRouteOf("/api/templates", "POST"), { kind: "stage" });
  assert.deepEqual(templateRouteOf("/api/templates/mine", "GET"), { kind: "mine" });
  assert.deepEqual(templateRouteOf("/api/templates/z7xup0Ax1SBl2K84PELqF/publish", "POST"), { kind: "publish", shareId: "z7xup0Ax1SBl2K84PELqF" });
  assert.deepEqual(templateRouteOf("/api/templates/z7xup0Ax1SBl2K84PELqF", "DELETE"), { kind: "delete", shareId: "z7xup0Ax1SBl2K84PELqF" });
  assert.equal(templateRouteOf("/api/templates/z7xup0Ax1SBl2K84PELqF", "GET"), undefined);
  assert.equal(templateRouteOf("/api/templates/import", "POST"), undefined, "the box's own import route");
  assert.equal(templateRouteOf("/api/templates/share", "POST"), undefined);
  assert.equal(sharePageIdOf("/t/z7xup0Ax1SBl2K84PELqF"), "z7xup0Ax1SBl2K84PELqF");
  assert.equal(sharePageIdOf("/t/nope"), undefined);
  assert.equal(shareUrl("https://box.example.com/", "z7xup0Ax1SBl2K84PELqF"), "https://box.example.com/t/z7xup0Ax1SBl2K84PELqF");
  assert.equal(shareUrl(undefined, "z7xup0Ax1SBl2K84PELqF"), undefined);
  assert.match(mintShareId(), /^[A-Za-z0-9_-]{21}$/);
});

test("a box's token finds its box, and a template is a parent with immutable versions", () => {
  const { store, boxA, boxA2, boxB, cleanup } = fixture();
  try {
    assert.equal(store.findBoxByToken("box", "box-token-box-a")?.id, "box-a");
    assert.equal(store.findBoxByToken("box", "box-token-box-b")?.id, "box-b");
    assert.equal(store.findBoxByToken("box", "wrong"), undefined);
    assert.equal(store.findBoxByToken("box", ""), undefined);

    const deps = { store, publicUrl: "https://box.example.com" };
    const first = handleTemplateApi({ kind: "stage" }, { document: DOCUMENT, sourceAgentId: "agent-1", visibility: "public", ownerName: "kin" }, boxA, deps);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const { shareId, version } = first.body as { shareId: string; version: number };
    assert.equal(version, 1);
    assert.match(shareId, /^[A-Za-z0-9_-]{21}$/);

    // Not live yet: the page and the document both 404, and the box's own view says unpublished.
    assert.equal(renderSharePage(store, shareId, undefined).status, 404);
    assert.equal(handleTemplateApi({ kind: "document", shareId }, {}, boxA, deps).status, 404);
    assert.equal(store.getTemplate(shareId)?.published, false);

    // A second export from the same agent keeps the id and appends version 2, still inactive.
    const second = handleTemplateApi({ kind: "stage" }, { document: DOCUMENT.replace("Turns videos", "Turns podcasts"), sourceAgentId: "agent-1", ownerName: "kin" }, boxA, deps);
    assert.deepEqual({ shareId: (second.body as { shareId: string }).shareId, version: (second.body as { version: number }).version }, { shareId, version: 2 });
    assert.equal(store.getTemplate(shareId)?.versions, 2);
    assert.equal(store.getTemplate(shareId)?.activeVersion, undefined);

    // Publish version 1: live at the link; the page shows the storefront and never the document.
    const published = handleTemplateApi({ kind: "publish", shareId }, { version: 1 }, boxA, deps);
    assert.equal(published.status, 200);
    assert.equal((published.body as { url: string }).url, `https://box.example.com/t/${shareId}`);
    const page = renderSharePage(store, shareId, undefined);
    assert.equal(page.status, 200);
    assert.match(page.html, /下载专家/);
    assert.match(page.html, /by kin/);
    assert.match(page.html, /Turns videos into transcripts\./, "version 1's description, not version 2's");
    assert.doesNotMatch(page.html, /lumenbox-template\/1/, "the document is not on the page");
    assert.match(page.html, new RegExp(`/\\?import=${shareId}`));
    assert.match(page.html, /made by another person/);

    // Rollback and replace are the same call; the live description follows the active version.
    assert.equal(handleTemplateApi({ kind: "publish", shareId }, { version: 2 }, boxA, deps).status, 200);
    assert.match(renderSharePage(store, shareId, undefined).html, /Turns podcasts/);
    assert.equal(handleTemplateApi({ kind: "publish", shareId }, { version: 1 }, boxA, deps).status, 200);
    assert.equal(store.templateDocument(shareId)?.version, 1);

    // Another box in the same tenant may read the document; it may not publish or delete.
    const read = handleTemplateApi({ kind: "document", shareId }, {}, boxA2, deps);
    assert.equal(read.status, 200);
    assert.equal(JSON.parse((read.body as { document: string }).document).profile.name, "下载专家");
    assert.equal(handleTemplateApi({ kind: "publish", shareId }, { version: 2 }, boxA2, deps).status, 404);
    assert.equal(handleTemplateApi({ kind: "delete", shareId }, {}, boxA2, deps).status, 404);

    // Unpublish kills the link now; delete frees the binding so the next stage mints a new id.
    assert.equal(handleTemplateApi({ kind: "unpublish", shareId }, {}, boxA, deps).status, 200);
    assert.equal(renderSharePage(store, shareId, undefined).status, 404);
    assert.equal(handleTemplateApi({ kind: "delete", shareId }, {}, boxA, deps).status, 200);
    assert.equal(store.getTemplate(shareId), undefined);
    const again = handleTemplateApi({ kind: "stage" }, { document: DOCUMENT, sourceAgentId: "agent-1" }, boxA, deps);
    assert.notEqual((again.body as { shareId: string }).shareId, shareId);
    assert.equal((again.body as { version: number }).version, 1);

    const mine = handleTemplateApi({ kind: "mine" }, {}, boxA, deps);
    assert.equal((mine.body as { templates: unknown[] }).templates.length, 1);
    assert.equal((handleTemplateApi({ kind: "mine" }, {}, boxB, deps).body as { templates: unknown[] }).templates.length, 0);
  } finally {
    cleanup();
  }
});

test("a team-only template is invisible outside its tenant, on the page and to a box", () => {
  const { store, boxA, boxB, tenantA, tenantB, cleanup } = fixture();
  try {
    const deps = { store };
    const staged = handleTemplateApi({ kind: "stage" }, { document: DOCUMENT, sourceAgentId: "agent-1", visibility: "tenant", ownerName: "kin" }, boxA, deps);
    const { shareId } = staged.body as { shareId: string };
    assert.equal(handleTemplateApi({ kind: "publish", shareId }, { version: 1 }, boxA, deps).status, 200);
    assert.equal((staged.body as { url?: string }).url, undefined, "no public url configured, no link");

    assert.equal(renderSharePage(store, shareId, undefined).status, 404, "anonymous");
    assert.equal(renderSharePage(store, shareId, { tenantId: tenantB.id }).status, 404, "another tenant");
    const own = renderSharePage(store, shareId, { tenantId: tenantA.id });
    assert.equal(own.status, 200);
    assert.match(own.html, /team only/);

    assert.equal(handleTemplateApi({ kind: "document", shareId }, {}, boxB, deps).status, 404);
    assert.equal(handleTemplateApi({ kind: "document", shareId }, {}, boxA, deps).status, 200);

    // Opening it to everyone is a separate, deliberate call — and only the owner's.
    assert.equal(handleTemplateApi({ kind: "visibility", shareId }, { visibility: "public" }, boxB, deps).status, 404);
    assert.equal(handleTemplateApi({ kind: "visibility", shareId }, { visibility: "public" }, boxA, deps).status, 200);
    assert.equal(renderSharePage(store, shareId, undefined).status, 200);
    assert.equal(handleTemplateApi({ kind: "document", shareId }, {}, boxB, deps).status, 200);

    // Every value on the page came from a box, so it is escaped.
    const hostile = handleTemplateApi(
      { kind: "stage" },
      { document: DOCUMENT.replace("下载专家", "<script>alert(1)</script>"), sourceAgentId: "agent-2", ownerName: "<b>x</b>" },
      boxA,
      deps
    );
    const hostileId = (hostile.body as { shareId: string }).shareId;
    handleTemplateApi({ kind: "publish", shareId: hostileId }, { version: 1 }, boxA, deps);
    const html = renderSharePage(store, hostileId, undefined).html;
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);

    // The audit trail names the box and the action.
    const actions = store.recentAudit(20).map(entry => entry.action);
    assert.ok(actions.includes("template.stage") && actions.includes("template.publish") && actions.includes("template.visibility"));
  } finally {
    cleanup();
  }
});

test("staging refuses what the control plane cannot serve a page for", () => {
  const { store, boxA, cleanup } = fixture();
  try {
    const deps = { store };
    assert.equal(handleTemplateApi({ kind: "stage" }, { document: "not json", sourceAgentId: "a" }, boxA, deps).status, 400);
    assert.equal(handleTemplateApi({ kind: "stage" }, { document: JSON.stringify({ profile: { name: "x" } }), sourceAgentId: "a" }, boxA, deps).status, 400, "no description");
    assert.equal(handleTemplateApi({ kind: "stage" }, { document: DOCUMENT }, boxA, deps).status, 400, "no source agent");
    assert.equal(handleTemplateApi({ kind: "publish", shareId: mintShareId() }, { version: 1 }, boxA, deps).status, 404);
    assert.equal(handleTemplateApi({ kind: "publish", shareId: mintShareId() }, {}, boxA, deps).status, 400);
  } finally {
    cleanup();
  }
});
