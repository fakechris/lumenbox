/**
 * The office writes (INV-754): FeishuWrite and DingTalkWrite, one function each, called from the
 * tool dispatcher with the connection already authorised. Here rather than in tools.ts so the
 * write path — key, duplicate check, read-back (INV-1395) — has room to be read whole.
 */

import { outcomeLine } from "../protocol/index.ts";
import { type OAuthProvider, scrubToken, tokenHeaders } from "./oauth.ts";
import { bitableKeyField, chunkBlocks, dingtalkEventBody, doorIdOf, doorIdsOf, eventWindow, feishuDocUrl, feishuEventBody, feishuTaskBody, instantOf, markdownToFeishuBlocks, readBackLine, sameTitle, writeKey, writeKeyUuid } from "./office-write.ts";
import type { ToolContext, ToolOutcome } from "./tools.ts";

export type ConnectorAuth = { provider: OAuthProvider; token: string };

/**
 * One JSON call through a connection, for the office tools (INV-754). No retry: a document create
 * has no key, and a create repeated after a lost answer is a second document. A lost answer is said
 * as unknown, with what to check, rather than tried again; the creates that do carry a key and a
 * read-back (INV-1395) are below.
 */
export async function connectorJson(
  auth: { provider: OAuthProvider; token: string },
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  body?: unknown
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; text: string; unknown?: true }> {
  let response: Response;
  try {
    response = await fetch(`${auth.provider.apiBase}${path}`, {
      method,
      headers: {
        ...tokenHeaders(auth.provider, auth.token),
        ...(auth.provider.apiHeaders ?? {}),
        ...(body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ok: false, unknown: true, text: `${auth.provider.title} did not answer (${error instanceof Error ? error.message : String(error)}); it may or may not have happened — check before trying again.` };
  }
  const raw = scrubToken(await response.text(), auth.token);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(raw) as Record<string, unknown>; } catch { /* the status speaks */ }
  // Feishu answers 200 with a non-zero `code` on refusal; DingTalk answers non-2xx with `code`/`message`.
  const code = json.code;
  const refused = response.status < 200 || response.status >= 300 || (typeof code === "number" && code !== 0);
  if (refused) {
    const why = typeof json.msg === "string" ? json.msg : typeof json.message === "string" ? json.message : raw.slice(0, 300);
    return { ok: false, text: `${auth.provider.title} refused ${method} ${path.split("?")[0]} (HTTP ${response.status}${code !== undefined ? `, code ${String(code)}` : ""}): ${why}` };
  }
  return { ok: true, json };
}

/** `domain` is the tenant's Feishu host (AGENTBOX_FEISHU_DOMAIN), read by the caller: it makes document links. */
export async function feishuWrite(input: Record<string, unknown>, context: ToolContext, auth: ConnectorAuth, domain: string | undefined): Promise<ToolOutcome> {
  const me = doorIdOf(context.callerIdentities, "feishu");
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map(item => item.trim()) : []);
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const zone = text(input.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fail = (message: string, unknown?: true) => ({ text: outcomeLine(unknown ? "unknown" : "failed", message), isError: true as const });
  const data = (json: Record<string, unknown>) => (json.data ?? {}) as Record<string, any>;
  // Appends in order, 50 blocks a call; stops at the first refusal and says how far it got.
  const appendMarkdown = async (documentId: string, markdown: string): Promise<{ added: number; failed?: string }> => {
    let added = 0;
    for (const chunk of chunkBlocks(markdownToFeishuBlocks(markdown))) {
      const reply = await connectorJson(auth, "POST", `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`, { children: chunk, index: -1 });
      if (!reply.ok) return { added, failed: reply.text };
      added += chunk.length;
    }
    return { added };
  };
  switch (String(input.action ?? "")) {
    case "doc_create": {
      const title = text(input.title);
      if (title === "" || title.length > 800) return fail("doc_create needs a title of 1–800 characters");
      const created = await connectorJson(auth, "POST", "/docx/v1/documents", { title, ...(text(input.folder_token) ? { folder_token: text(input.folder_token) } : {}) });
      if (!created.ok) return fail(created.text, created.unknown);
      const id = String(data(created.json).document?.document_id ?? "");
      // Feishu said yes but named no document: something may exist, and nothing after this can address it.
      if (id === "") return fail("Feishu accepted doc_create but returned no document id, so the document may or may not exist and cannot be shared or written to — check Feishu Docs for the title before trying again", true);
      const lines = [`Created "${title}" (document ${id}).`];
      // A document the app creates is invisible to everyone else until someone is added.
      const grant = (openId: string, perm: "edit" | "full_access") =>
        connectorJson(auth, "POST", `/drive/v1/permissions/${encodeURIComponent(id)}/members?type=docx`, { member_type: "openid", member_id: openId, perm, type: "user" });
      if (me !== undefined) {
        // A person can carry more than one feishu: identity (a replaced door leaves the old
        // one behind), and an open_id is only valid for the app that issued it — so try each,
        // newest first, and stop at the one this app accepts.
        let added = await grant(me, "full_access");
        for (const older of doorIdsOf(context.callerIdentities, "feishu").filter(id => id !== me)) {
          if (added.ok) break;
          added = await grant(older, "full_access");
        }
        lines.push(added.ok ? "The person who asked can open and edit it." : `Could not add the person who asked (${added.text}). If the connected Feishu app is not the one that runs this chat, their id differs between the two; the document exists but only the app can see it.`);
      } else {
        lines.push("Their Feishu id is not known here, so only the app can see it yet — ask whom to add, or share it with share_with.");
      }
      for (const other of strings(input.share_with)) {
        const shared = await grant(other, "edit");
        lines.push(shared.ok ? `Shared with ${other} (edit).` : `Could not share with ${other}: ${shared.text}`);
      }
      if (text(input.markdown) !== "") {
        const appended = await appendMarkdown(id, String(input.markdown));
        lines.push(appended.failed === undefined ? `Wrote ${appended.added} block(s).` : `Wrote ${appended.added} block(s), then stopped: ${appended.failed}`);
      }
      const url = feishuDocUrl(id, domain);
      lines.push(url !== undefined ? `Link: ${url}` : "Link: open Feishu Docs and search the title (set AGENTBOX_FEISHU_DOMAIN to get direct links).");
      return { text: `${outcomeLine("ok")} ${lines.join(" ")}` };
    }
    case "doc_append": {
      const id = text(input.document_id);
      if (id === "" || text(input.markdown) === "") return fail("doc_append needs document_id and markdown");
      const appended = await appendMarkdown(id, String(input.markdown));
      return appended.failed === undefined
        ? { text: `${outcomeLine("ok")} Appended ${appended.added} block(s) to ${id}.` }
        : fail(`Appended ${appended.added} block(s) to ${id}, then stopped: ${appended.failed}`);
    }
    case "bitable_add":
    case "bitable_update":
    case "bitable_search": {
      const app = text(input.app_token);
      const table = text(input.table_id);
      if (app === "" || table === "") return fail("Bitable actions need app_token and table_id (both are in the base's URL)");
      const base = `/bitable/v1/apps/${encodeURIComponent(app)}/tables/${encodeURIComponent(table)}/records`;
      if (input.action === "bitable_search") {
        const contains = (typeof input.contains === "object" && input.contains !== null ? input.contains : {}) as Record<string, unknown>;
        const conditions = Object.entries(contains).map(([field_name, value]) => ({ field_name, operator: "contains", value: [String(value)] }));
        const found = await connectorJson(auth, "POST", `${base}/search?page_size=50`, conditions.length > 0 ? { filter: { conjunction: "and", conditions } } : {});
        if (!found.ok) return fail(found.text, found.unknown);
        const items = (data(found.json).items ?? []) as { record_id: string; fields: Record<string, unknown> }[];
        // Text cells come back as [{text, type}]; flattened so the model reads values, not structure.
        const flat = items.map(item => ({ record_id: item.record_id, fields: Object.fromEntries(Object.entries(item.fields ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.map(part => (typeof part === "object" && part !== null && "text" in part ? (part as { text: string }).text : part)).join("") : value])) }));
        return { text: `${outcomeLine("ok")} ${items.length} record(s)${data(found.json).has_more ? " (more exist; narrow the search)" : ""}.\n${JSON.stringify(flat).slice(0, 20_000)}` };
      }
      const fields = (typeof input.fields === "object" && input.fields !== null ? input.fields : undefined) as Record<string, unknown> | undefined;
      if (fields === undefined || Object.keys(fields).length === 0) return fail(`${String(input.action)} needs fields`);
      if (input.action === "bitable_add") {
        // Before: a row with the same key value is this row already written.
        const keyField = bitableKeyField(fields);
        if (keyField !== undefined) {
          const same = await connectorJson(auth, "POST", `${base}/search?page_size=1`, { filter: { conjunction: "and", conditions: [{ field_name: keyField.name, operator: "is", value: [keyField.value] }] } });
          const existing = same.ok ? ((data(same.json).items ?? []) as { record_id: string }[])[0] : undefined;
          if (existing !== undefined) return { text: `${outcomeLine("ok")} Nothing added: a record with ${keyField.name} "${keyField.value}" already exists — duplicate_of ${existing.record_id}. Update it with bitable_update if it should change.` };
        }
        const added = await connectorJson(auth, "POST", `${base}?client_token=${writeKeyUuid("feishu", "bitable", app, table, fields)}`, { fields });
        if (!added.ok) return fail(added.text, added.unknown);
        const id = String(data(added.json).record?.record_id ?? "");
        // After: the create's answer is the vendor accepting the request; reading the row back is it being there.
        const read = readBackLine(id === "" ? { ok: false, text: "no record id came back" } : await connectorJson(auth, "GET", `${base}/${encodeURIComponent(id)}`), `Record ${id}`);
        return read.outcome === "ok" ? { text: `${outcomeLine("ok")} Added record ${id}. ${read.text}` } : fail(read.text, true);
      }
      const record = text(input.record_id);
      if (record === "") return fail("bitable_update needs record_id");
      const updated = await connectorJson(auth, "PUT", `${base}/${encodeURIComponent(record)}`, { fields });
      return updated.ok ? { text: `${outcomeLine("ok")} Updated record ${record}: ${Object.keys(fields).join(", ")}.` } : fail(updated.text, updated.unknown);
    }
    case "calendar_event": {
      const summary = text(input.summary);
      const startMs = instantOf(text(input.start), zone);
      const endMs = instantOf(text(input.end), zone);
      if (summary === "" || startMs === undefined || endMs === undefined || endMs <= startMs) return fail("calendar_event needs summary, and a start before its end (\"2026-10-03 15:00\" with timezone, or ISO with an offset)");
      const primary = await connectorJson(auth, "POST", "/calendar/v4/calendars/primary");
      if (!primary.ok) return fail(`${primary.text} (the app needs its bot capability turned on to have a calendar)`, primary.unknown);
      const calendarId = String((data(primary.json).calendars ?? [])[0]?.calendar?.calendar_id ?? "");
      if (calendarId === "") return fail("Feishu returned no primary calendar for the connected app, so no event was created (the app needs its bot capability turned on to have a calendar)");
      const events = `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`;
      // Before: an event of this title starting at this moment is this event already written.
      const window = eventWindow(startMs, endMs);
      const same = await connectorJson(auth, "GET", `${events}?start_time=${window.fromS}&end_time=${window.toS}&page_size=50`);
      const existing = same.ok ? ((data(same.json).items ?? []) as { event_id: string; summary?: string; start_time?: { timestamp?: string }; app_link?: string }[])
        .find(item => sameTitle(item.summary, summary) && item.start_time?.timestamp === String(window.fromS)) : undefined;
      if (existing !== undefined) return { text: `${outcomeLine("ok")} Nothing created: "${summary}" at that time already exists — duplicate_of ${existing.event_id}.${typeof existing.app_link === "string" ? ` Link: ${existing.app_link}` : ""}` };
      const created = await connectorJson(auth, "POST", `${events}?idempotency_key=${writeKey("feishu", "event", calendarId, summary, window.fromS, window.toS)}`,
        feishuEventBody({ summary, description: text(input.description), startMs, endMs, timezone: zone }));
      if (!created.ok) return fail(created.text, created.unknown);
      const event = data(created.json).event ?? {};
      const eventId = String(event.event_id ?? "");
      // After: read it back before inviting anyone to it.
      const read = readBackLine(eventId === "" ? { ok: false, text: "no event id came back" } : await connectorJson(auth, "GET", `${events}/${encodeURIComponent(eventId)}`), `The event`);
      if (read.outcome !== "ok") return fail(read.text, true);
      const invite = [...(me !== undefined ? [me] : []), ...strings(input.attendees).filter(id => id !== me)];
      const lines = [`Created "${summary}" on the app's calendar (${eventId}, read back).`];
      if (invite.length > 0) {
        const invited = await connectorJson(auth, "POST", `${events}/${encodeURIComponent(eventId)}/attendees?user_id_type=open_id`,
          { attendees: invite.map(user_id => ({ type: "user", user_id })), need_notification: true });
        lines.push(invited.ok ? `Invited ${invite.length} person(s)${me !== undefined ? ", including the person who asked, so it is on their calendar" : ""}.` : `The event exists but inviting failed: ${invited.text}`);
      } else {
        lines.push("Nobody is invited, so it is on the app's calendar only — say so, or add attendees.");
      }
      if (typeof event.app_link === "string") lines.push(`Link: ${event.app_link}`);
      return { text: `${outcomeLine("ok")} ${lines.join(" ")}` };
    }
    case "task_create": {
      const summary = text(input.summary);
      if (summary === "") return fail("task_create needs a summary");
      const dueText = text(input.due);
      const dueMs = dueText === "" ? undefined : instantOf(dueText, zone);
      if (dueText !== "" && dueMs === undefined) return fail("due is not a time I can read — use \"2026-10-03\", \"2026-10-03 18:00\" with timezone, or ISO");
      const assignees = strings(input.assignees);
      // A task the app creates is visible only to its members: the person who asked follows it.
      const body = feishuTaskBody({ summary, description: text(input.description), ...(dueMs !== undefined ? { dueMs, allDay: /^\d{4}-\d{2}-\d{2}$/.test(dueText) } : {}), assignees, followers: me !== undefined ? [me] : [] });
      // Before: an open task of this title is this task already written (the vendor offers no key for tasks).
      const open = await connectorJson(auth, "GET", "/task/v2/tasks?page_size=50&completed=false&user_id_type=open_id");
      const existing = open.ok ? ((data(open.json).items ?? []) as { guid: string; summary?: string; url?: string }[]).find(item => sameTitle(item.summary, summary)) : undefined;
      if (existing !== undefined) return { text: `${outcomeLine("ok")} Nothing created: an open task "${summary}" already exists — duplicate_of ${existing.guid}.${typeof existing.url === "string" ? ` Link: ${existing.url}` : ""}` };
      const created = await connectorJson(auth, "POST", "/task/v2/tasks?user_id_type=open_id", body);
      if (!created.ok) return fail(created.text, created.unknown);
      const task = data(created.json).task ?? {};
      const guid = String(task.guid ?? "");
      const read = readBackLine(guid === "" ? { ok: false, text: "no task guid came back" } : await connectorJson(auth, "GET", `/task/v2/tasks/${encodeURIComponent(guid)}`), `The task`);
      if (read.outcome !== "ok") return fail(read.text, true);
      return { text: `${outcomeLine("ok")} Created task "${summary}" (${guid}, read back)${me === undefined && assignees.length === 0 ? " — nobody is a member, so only the app can see it; say so" : ""}.${typeof task.url === "string" ? ` Link: ${task.url}` : ""}` };
    }
    case "task_complete": {
      const guid = text(input.task_guid);
      if (guid === "") return fail("task_complete needs task_guid");
      const done = await connectorJson(auth, "PATCH", `/task/v2/tasks/${encodeURIComponent(guid)}`, { task: { completed_at: String(Date.now()) }, update_fields: ["completed_at"] });
      return done.ok ? { text: `${outcomeLine("ok")} Marked ${guid} complete.` } : fail(done.text, done.unknown);
    }
    default:
      return fail("FeishuWrite needs an action: doc_create, doc_append, bitable_add, bitable_update, bitable_search, calendar_event, task_create or task_complete");
  }
}


export async function dingtalkWrite(input: Record<string, unknown>, context: ToolContext, auth: ConnectorAuth): Promise<ToolOutcome> {
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const fail = (message: string, unknown?: true) => ({ text: outcomeLine(unknown ? "unknown" : "failed", message), isError: true as const });
  const operator = text(input.operator_union_id) || doorIdOf(context.callerIdentities, "dingtalk");
  if (operator === undefined || operator === "") return fail("DingTalk acts for a person by unionId, and whose is not known here — pass operator_union_id");
  if (input.action === "doc_create") {
    const name = text(input.name);
    if (name === "") return fail("doc_create needs a name");
    let workspace = text(input.workspace_id);
    if (workspace === "") {
      const mine = await connectorJson(auth, "GET", `/v2.0/wiki/mineWorkspaces?operatorId=${encodeURIComponent(operator)}`);
      if (!mine.ok) return fail(mine.text, mine.unknown);
      workspace = String((mine.json.workspace as { workspaceId?: string } | undefined)?.workspaceId ?? "");
      if (workspace === "") return fail("DingTalk did not return a My Documents space for this person; pass workspace_id");
    }
    const created = await connectorJson(auth, "POST", `/v1.0/doc/workspaces/${encodeURIComponent(workspace)}/docs`, { name, docType: "DOC", operatorId: operator });
    if (!created.ok) return fail(created.text, created.unknown);
    return { text: `${outcomeLine("ok")} Created the DingTalk document "${name}", empty — writing its body is not supported yet, so tell the person to paste it or use a file.${typeof created.json.url === "string" ? ` Link: ${created.json.url}` : ""}` };
  }
  if (input.action === "calendar_event") {
    const summary = text(input.summary);
    const zone = text(input.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const startMs = instantOf(text(input.start), zone);
    const endMs = instantOf(text(input.end), zone);
    if (summary === "" || startMs === undefined || endMs === undefined || endMs <= startMs) return fail("calendar_event needs summary, and a start before its end");
    const attendees = Array.isArray(input.attendees) ? input.attendees.filter((id): id is string => typeof id === "string" && id.trim() !== "") : [];
    const events = `/v1.0/calendar/users/${encodeURIComponent(operator)}/calendars/primary/events`;
    // Before: an event of this title in this span is this event already written (DingTalk offers no key).
    const same = await connectorJson(auth, "GET", `${events}?timeMin=${encodeURIComponent(new Date(startMs).toISOString())}&timeMax=${encodeURIComponent(new Date(endMs).toISOString())}&maxResults=50`);
    const existing = same.ok ? ((same.json.events ?? []) as { id: string; summary?: string }[]).find(item => sameTitle(item.summary, summary)) : undefined;
    if (existing !== undefined) return { text: `${outcomeLine("ok")} Nothing created: "${summary}" in that span already exists — duplicate_of ${existing.id}.` };
    const created = await connectorJson(auth, "POST", events, dingtalkEventBody({ summary, description: text(input.description), startMs, endMs, timezone: zone, attendees }));
    if (!created.ok) return fail(created.text, created.unknown);
    const id = String(created.json.id ?? "");
    const read = readBackLine(id === "" ? { ok: false, text: "no event id came back" } : await connectorJson(auth, "GET", `${events}/${encodeURIComponent(id)}`), `The event`);
    if (read.outcome !== "ok") return fail(read.text, true);
    return { text: `${outcomeLine("ok")} Created "${summary}" on the person's DingTalk calendar${attendees.length > 0 ? `, inviting ${attendees.length}` : ""} (event ${id}, read back).` };
  }
  return fail("DingTalkWrite needs an action: doc_create or calendar_event");
}
