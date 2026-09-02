/**
 * Template share links on the control plane (docs/29 §6 B).
 *
 * Two kinds of caller. A **box** speaks with its own token: it stages a version, publishes,
 * unpublishes, changes who may see it, deletes, and — when one of its people is importing —
 * fetches another template's live document. A **person** speaks with the session cookie
 * only to look at the share page. Nothing here proxies to a box, and the document never
 * rides a public response: the page shows the storefront, the document goes to a box.
 *
 * Pure request handling: the gateway hands in a parsed route, the body, the caller, and gets
 * back a status and a body. That is what makes it testable without a socket.
 */

import type { BoxRow, ControlStore, TemplateVisibility } from "./store.ts";

export type TemplateRoute =
  | { kind: "stage" }
  | { kind: "publish"; shareId: string }
  | { kind: "unpublish"; shareId: string }
  | { kind: "visibility"; shareId: string }
  | { kind: "delete"; shareId: string }
  | { kind: "document"; shareId: string }
  | { kind: "mine" };

/** `/api/templates/...` for a box; undefined when the path is not one of ours. */
export function templateRouteOf(pathname: string, method: string): TemplateRoute | undefined {
  if (pathname === "/api/templates" && method === "POST") return { kind: "stage" };
  if (pathname === "/api/templates/mine" && method === "GET") return { kind: "mine" };
  const match = /^\/api\/templates\/([A-Za-z0-9_-]{21})(?:\/(publish|unpublish|visibility|document))?$/.exec(pathname);
  if (match === null) return undefined;
  const shareId = match[1]!;
  const action = match[2];
  if (action === undefined) return method === "DELETE" ? { kind: "delete", shareId } : undefined;
  if (action === "document") return method === "GET" ? { kind: "document", shareId } : undefined;
  if (method !== "POST") return undefined;
  return { kind: action as "publish" | "unpublish" | "visibility", shareId };
}

/** `/t/<shareId>` — the public page. */
export function sharePageIdOf(pathname: string): string | undefined {
  const match = /^\/t\/([A-Za-z0-9_-]{21})\/?$/.exec(pathname);
  return match === null ? undefined : match[1];
}

export interface TemplateApiDeps {
  store: ControlStore;
  /** Where a share page lives, as a person reaches it. Absent means links cannot be built. */
  publicUrl?: string;
  now?: () => string;
}

export interface TemplateReply {
  status: number;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visibilityOf(value: unknown): TemplateVisibility | undefined {
  return value === "public" || value === "tenant" ? value : undefined;
}

/** The whole document, checked only for what the control plane must know; the box validated the rest. */
const DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;

export function shareUrl(publicUrl: string | undefined, shareId: string): string | undefined {
  return publicUrl === undefined ? undefined : `${publicUrl.replace(/\/+$/, "")}/t/${shareId}`;
}

/**
 * Handles one box-authenticated call. `box` is the caller, resolved by the gateway from the
 * token; every mutation checks the row belongs to that box, and `document` checks the reader
 * may see it.
 */
export function handleTemplateApi(
  route: TemplateRoute,
  body: Record<string, unknown>,
  box: BoxRow,
  deps: TemplateApiDeps
): TemplateReply {
  const { store } = deps;
  const url = (shareId: string) => shareUrl(deps.publicUrl, shareId);
  const view = (shareId: string) => {
    const row = store.getTemplate(shareId);
    return row === undefined
      ? undefined
      : {
          shareId: row.shareId,
          name: row.name,
          description: row.description,
          visibility: row.visibility,
          published: row.published,
          activeVersion: row.activeVersion,
          versions: row.versions,
          sourceAgentId: row.sourceAgentId,
          url: url(row.shareId),
          updatedAt: row.updatedAt,
        };
  };

  switch (route.kind) {
    case "stage": {
      const document = typeof body.document === "string" ? body.document : isRecord(body.document) ? JSON.stringify(body.document) : "";
      if (document === "" || Buffer.byteLength(document, "utf8") > DOCUMENT_MAX_BYTES) {
        return { status: 400, body: { error: "Pass the template document (≤ 2 MiB) as `document`." } };
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(document) as Record<string, unknown>;
      } catch {
        return { status: 400, body: { error: "The document is not JSON." } };
      }
      const profile = isRecord(parsed.profile) ? parsed.profile : {};
      const name = typeof profile.name === "string" ? profile.name.trim() : "";
      const description = typeof profile.description === "string" ? profile.description.trim() : "";
      const sourceAgentId = typeof body.sourceAgentId === "string" ? body.sourceAgentId.trim() : "";
      if (name === "" || description === "" || sourceAgentId === "") {
        return { status: 400, body: { error: "A template needs profile.name, profile.description and a sourceAgentId." } };
      }
      const visibility = visibilityOf(body.visibility) ?? "public";
      const ownerName = typeof body.ownerName === "string" && body.ownerName.trim() !== "" ? body.ownerName.trim().slice(0, 72) : "someone";
      const ownerUserId = typeof body.ownerUserId === "string" ? body.ownerUserId : "";
      const staged = store.stageTemplate({
        tenantId: box.tenantId,
        ownerUserId,
        ownerName,
        boxId: box.id,
        sourceAgentId,
        name,
        description,
        ...(typeof profile.avatarColor === "string" ? { avatarColor: profile.avatarColor } : {}),
        visibility,
        document,
      });
      store.audit({ tenantId: box.tenantId, actor: `box:${box.id}`, action: "template.stage", target: staged.shareId, detail: { version: staged.version, sourceAgentId } });
      return { status: 200, body: { ...staged, url: url(staged.shareId), template: view(staged.shareId) } };
    }
    case "publish": {
      const version = Number(body.version);
      if (!Number.isInteger(version) || version < 1) return { status: 400, body: { error: "Pass the version to publish." } };
      if (!store.activateTemplateVersion(route.shareId, version, box.id)) {
        return { status: 404, body: { error: "No such version of a template this box owns." } };
      }
      store.audit({ tenantId: box.tenantId, actor: `box:${box.id}`, action: "template.publish", target: route.shareId, detail: { version } });
      return { status: 200, body: { ok: true, url: url(route.shareId), template: view(route.shareId) } };
    }
    case "unpublish": {
      if (!store.unpublishTemplate(route.shareId, box.id)) return { status: 404, body: { error: "No such template owned by this box." } };
      store.audit({ tenantId: box.tenantId, actor: `box:${box.id}`, action: "template.unpublish", target: route.shareId });
      return { status: 200, body: { ok: true, template: view(route.shareId) } };
    }
    case "visibility": {
      const visibility = visibilityOf(body.visibility);
      if (visibility === undefined) return { status: 400, body: { error: "visibility is public or tenant." } };
      if (!store.setTemplateVisibility(route.shareId, visibility, box.id)) return { status: 404, body: { error: "No such template owned by this box." } };
      store.audit({ tenantId: box.tenantId, actor: `box:${box.id}`, action: "template.visibility", target: route.shareId, detail: { visibility } });
      return { status: 200, body: { ok: true, template: view(route.shareId) } };
    }
    case "delete": {
      if (!store.deleteTemplate(route.shareId, box.id)) return { status: 404, body: { error: "No such template owned by this box." } };
      store.audit({ tenantId: box.tenantId, actor: `box:${box.id}`, action: "template.delete", target: route.shareId });
      return { status: 200, body: { ok: true } };
    }
    case "document": {
      const row = store.getTemplate(route.shareId);
      // One answer for "not there", "not published" and "not yours to see": a probe learns nothing.
      const gone = { status: 404, body: { error: "This template could not be found. The link may have expired or been deleted." } };
      if (row === undefined || !row.published) return gone;
      if (row.visibility === "tenant" && row.tenantId !== box.tenantId) return gone;
      const live = store.templateDocument(route.shareId);
      if (live === undefined) return gone;
      return {
        status: 200,
        body: {
          shareId: row.shareId,
          version: live.version,
          name: row.name,
          description: row.description,
          ownerName: row.ownerName,
          visibility: row.visibility,
          document: live.document,
        },
      };
    }
    case "mine":
      return { status: 200, body: { templates: store.templatesOfBox(box.id).map(row => view(row.shareId)) } };
  }
}

/** HTML-escape for the share page: every value on it came from a box. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/**
 * The share page: what a person sees before adding. The storefront only — name, description,
 * creator, the third-party notice — and a button that lands them on their own box with the id.
 * `viewer` decides whether a tenant-only template is shown at all; the answer for anyone else
 * is the same 404 the document gives.
 */
export function renderSharePage(
  store: ControlStore,
  shareId: string,
  viewer: { tenantId: string } | undefined
): { status: number; html: string } {
  const row = store.getTemplate(shareId);
  const notFound = {
    status: 404,
    html:
      `<!doctype html><meta charset="utf-8"><title>Not found</title>` +
      `<body style="font:15px system-ui;padding:3rem;max-width:32rem"><h1>This template could not be found.</h1>` +
      `<p>The share link may have expired or been deleted.</p></body>`,
  };
  if (row === undefined || !row.published || row.activeVersion === undefined) return notFound;
  if (row.visibility === "tenant" && viewer?.tenantId !== row.tenantId) return notFound;
  const color = escapeHtml(row.avatarColor ?? "#888");
  const html =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(row.name)} by ${escapeHtml(row.ownerName)}</title>` +
    `<body style="font:15px system-ui;padding:3rem 1.5rem;max-width:32rem;margin:auto;color:#222">` +
    `<div style="width:64px;height:64px;border-radius:50%;background:${color};margin:0 auto 1rem"></div>` +
    `<h1 style="text-align:center;font-size:1.4rem;margin:0">${escapeHtml(row.name)}</h1>` +
    `<p style="text-align:center;color:#666;margin:.25rem 0 1.25rem">by ${escapeHtml(row.ownerName)}${row.visibility === "tenant" ? " · team only" : ""}</p>` +
    `<p style="text-align:center">${escapeHtml(row.description)}</p>` +
    `<p style="text-align:center;margin:1.5rem 0"><a href="/?import=${encodeURIComponent(shareId)}" ` +
    `style="display:inline-block;background:#111;color:#fff;padding:.6rem 1.2rem;border-radius:8px;text-decoration:none">Add to lumenbox</a></p>` +
    `<p style="font-size:12px;color:#888;text-align:center">This bot was made by another person, not by lumenbox. Adding it creates your own copy: ` +
    `its skills and conventions, no logins, no files, no history. Its routines start paused. It may act on your behalf once you turn them on.</p>` +
    `<p style="font-size:12px;color:#888;text-align:center">Version ${row.activeVersion} · <a href="/gateway/login?next=${encodeURIComponent(`/?import=${shareId}`)}" style="color:#888">sign in first</a> if the button does not land you on your box.</p>` +
    `</body>`;
  return { status: 200, html };
}
