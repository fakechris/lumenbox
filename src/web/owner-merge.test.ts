/**
 * The rehearsal on a de-identified six-person roster (INV-1698): a desktop installation from before
 * INV-1685, whose people are one person through two Feishu apps, DingTalk and a browser, is
 * previewed and confirmed over HTTP, and after the restart it is a personal installation with one
 * Owner who holds every identity, owns the old tokens, and links another door with their own code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "./server.ts";
import { OWNER_ID } from "../host/installation.ts";
import { MERGE_JOURNAL } from "../host/self-merge.ts";
import { INSTALLATION_JS } from "./installation-ui.ts";
import { SIX, SIX_IDS, writeSixIdentities } from "../host/testing/six-identities.ts";

test("six identities of one person: previewed, confirmed, merged at the restart into one Owner who links the next door with their own code", async () => {
  const home = mkdtempSync(join(tmpdir(), "owner-merge-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  const logs: string[] = [];
  let base = "";
  const start = async () => { stop?.(); stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", useBox: false, desktop: true, onLog: line => logs.push(line), onReady: url => { base = url; } }); };
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: "Bearer t0k", "accept-language": "en" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  };
  try {
    writeSixIdentities(home, { ledgers: false, boxes: false });
    await start(); // the registry writes its box list; the default box is then given members, as an installation with people has
    const boxesPath = join(home, "agents", "boxes.json");
    const boxes = JSON.parse(readFileSync(boxesPath, "utf8")) as { members: unknown }[];
    boxes[0]!.members = [SIX.admin, SIX.work1];
    writeFileSync(boxesPath, JSON.stringify(boxes, null, 2));
    await start();

    assert.equal(((await call("/api/channels")).body.installation as { mode: string }).mode, "organisation", "no installation field: read as an organisation, as before");
    const preview = await call("/api/installation/merge");
    assert.equal(preview.status, 200);
    assert.equal(preview.body.offered, true);
    assert.equal((preview.body.people as unknown[]).length, 6);
    const changes = Object.fromEntries((preview.body.changes as { store: string; records: number }[]).map(change => [change.store, change.records]));
    assert.equal(changes["mcp-tokens"], 2);
    assert.equal(changes["box-members"], 1);
    assert.equal(((await call("/api/channels")).body.principals as unknown[]).length, 6, "a preview changes nothing");

    assert.equal((await call("/api/installation/merge", { confirm: true, digest: "an-old-preview" })).status, 409);
    assert.equal((await call("/api/installation/merge", { digest: preview.body.digest })).status, 400, "no merge without an explicit yes");
    const confirmed = await call("/api/installation/merge", { confirm: true, digest: preview.body.digest, name: "Sam" });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.restartNeeded, true);
    assert.equal(((await call("/api/channels")).body.principals as unknown[]).length, 6, "the merge waits for the restart");

    await start();
    assert.ok(logs.some(line => line.startsWith("upgrade: 6 people on this desktop installation were confirmed to be one person")));
    const channels = (await call("/api/channels")).body;
    assert.equal((channels.installation as { mode: string }).mode, "single-machine");
    const people = channels.principals as { id: string; name: string; role: string; identities: string[]; aliases: string[] }[];
    assert.deepEqual(people.map(person => [person.id, person.name, person.role]), [[OWNER_ID, "Sam", "admin"]]);
    assert.deepEqual(people[0]!.identities, [...SIX_IDS]);
    assert.deepEqual(people[0]!.aliases, [...SIX_IDS]);
    assert.equal((await call("/api/me")).body.label, "owner", "the unsigned operator is the Owner now");
    const record = (await call("/api/person")).body as { principal: string; entries: { text: string }[] };
    assert.deepEqual([record.principal, record.entries.map(entry => entry.text).sort()], [OWNER_ID, ["replies in Chinese", "reviews in the evening"]], "Settings → Mine, signed out, is the Owner's one record: what DingTalk wrote and what the desktop wrote as `me` (INV-1705)");
    const tokens = (await call("/api/mcp")).body.tokens as { principalId: string; mine: boolean }[];
    assert.deepEqual(tokens.map(token => [token.principalId, token.mine]), [[OWNER_ID, true], [OWNER_ID, true]], "the old tokens are the Owner's");
    assert.deepEqual((JSON.parse(readFileSync(boxesPath, "utf8")) as { members: unknown }[])[0]!.members, [OWNER_ID]);
    assert.equal((await call("/api/installation/merge")).body.offered, false);

    // After the merge, a new door is the Owner's own code — and a code for anyone else is refused.
    assert.equal((await call("/api/channels/invite", { role: "driver" })).status, 409);
    const code = await call("/api/channels/invite", { principalId: OWNER_ID });
    assert.equal(code.status, 200);
    const login = await call("/api/login", { code: code.body.code });
    assert.deepEqual([login.status, login.body.name, login.body.role], [200, "Sam", "admin"]);
    const after = ((await call("/api/channels")).body.principals as { identities: string[] }[]);
    assert.equal(after.length, 1);
    assert.equal(after[0]!.identities.length, 7, "a browser linked to the Owner, nobody added");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("\"these are not all me\" keeps six people as an organisation, unchanged, and People says to use an organisation (INV-1706)", async () => {
  const home = mkdtempSync(join(tmpdir(), "owner-decline-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  const logs: string[] = [];
  let base = "";
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: "Bearer t0k" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  };
  try {
    writeSixIdentities(home, { ledgers: false, boxes: false });
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", useBox: false, desktop: true, onLog: line => logs.push(line), onReady: url => { base = url; } });
    const preview = await call("/api/installation/merge");
    assert.deepEqual([preview.body.offered, preview.body.severalPeople], [true, false], "no answer yet: the merge is offered, no notice");
    assert.equal((await call("/api/installation/merge", { decline: true, confirm: true, digest: preview.body.digest })).status, 400, "yes and no at once is no answer");
    assert.equal((await call("/api/installation/merge", { decline: true, digest: "an-old-preview" })).status, 409);
    const rosterPath = join(home, "principals.json");
    const before = JSON.parse(readFileSync(rosterPath, "utf8")) as { principals: unknown[] };
    const declined = await call("/api/installation/merge", { decline: true, digest: preview.body.digest });
    assert.deepEqual([declined.status, declined.body.state], [200, "declined"]);
    assert.ok(logs.some(line => line.includes("not all one person") && line.includes("INV-1706")));
    const after = JSON.parse(readFileSync(rosterPath, "utf8")) as { principals: unknown[]; installation: { mode: string; declined: { by: string } } };
    assert.deepEqual(after.principals, before.principals, "nobody moved, merged or removed");
    assert.equal(after.installation.mode, "organisation");
    assert.equal(after.installation.declined.by, "the operator");
    assert.equal(existsSync(join(home, MERGE_JOURNAL)), false, "no merge pending");
    const again = await call("/api/installation/merge");
    assert.deepEqual([again.body.offered, again.body.reason, again.body.severalPeople], [false, "decided", true], "the notice instead of the offer");
    assert.equal((await call("/api/channels/invite", { role: "driver" })).status, 200, "nothing restricted: an organisation still invites");
    assert.doesNotThrow(() => new Function(INSTALLATION_JS), "the People script that offers the answer and shows the notice parses");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
