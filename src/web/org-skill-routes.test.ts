/**
 * The organisation skill routes (INV-2222): Admin only, every one of them; an organisation only;
 * a skill is published from an upload, a template or a box the Admin may enter; a credential is
 * refused; and the page is told which boxes hold what the library says.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallationMode } from "../host/installation.ts";
import { OrgSkillSync } from "../host/org-skill-sync.ts";
import { OrgSkills } from "../host/org-skills.ts";
import { type Role, roleAtLeast } from "../host/principals.ts";
import { orgSkillRoute } from "./org-skill-routes.ts";

const skillText = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`;
const ROUTES = [
  "GET /api/org-skills", "GET /api/org-skills/history", "GET /api/org-skills/offers", "POST /api/org-skills/publish", "POST /api/org-skills/withdraw",
  "POST /api/org-skills/require", "POST /api/org-skills/sync", "POST /api/org-skills/offers/decide",
];
/** A member's own: a driver may, a viewer may not. */
const MEMBER_ROUTES = ["POST /api/org-skills/offer", "GET /api/org-skills/offers/mine", "GET /api/org-skills/box"];

test("admin only on every route, an organisation only; publish from an upload, a template and a box; update, require, withdraw; a credential is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-org-skill-routes-"));
  try {
    let mode: InstallationMode = "organisation";
    let role: Role = "driver";
    let body: Record<string, unknown> = {};
    const library = new OrgSkills(home, { mode: () => mode });
    // One box the Admin may enter, holding a skill of its own; the sync is asked for nothing but where boxes stand.
    const boxFiles: Record<string, string> = { "/w/skills/weekly/SKILL.md": skillText("Weekly", "Use when the week ends."), "/w/skills/weekly/scripts/run.sh": "echo week\n" };
    const box = {
      listDir: async (path: string) => {
        const names = new Map<string, string>();
        for (const key of Object.keys(boxFiles)) if (key.startsWith(`${path}/`)) names.set(key.slice(path.length + 1).split("/")[0]!, key.slice(path.length + 1).includes("/") ? "directory" : "file");
        if (names.size === 0) throw new Error("no such directory");
        return { entries: [...names].map(([name, type]) => ({ name, type })) };
      },
      readFile: async (path: string) => ({ content: boxFiles[path]! }),
    };
    const sync = new OrgSkillSync({ library, boxes: () => [{ id: "b1", name: "ann", root: "/w/.lumenbox/org-skills" }, { id: "b2", name: "bo", root: "/w/.lumenbox/org-skills" }], client: () => undefined, log: () => {} });
    const refusals: string[] = [], told: string[][] = [];
    let who = "p-admin";
    const call = (route: string, params = "") => orgSkillRoute(route, {
      library, sync, boxes: () => [{ id: "b1", name: "ann", skills: "/w/skills" }], box: id => (id === "b1" ? box : undefined), readJson: async () => body, params: new URLSearchParams(params),
      refusedAdmin: () => { if (roleAtLeast(role, "admin")) return false; refusals.push(route); return true; },
      refusedDriver: () => { if (roleAtLeast(role, "driver")) return false; refusals.push(route); return true; }, tell: (id, outcome) => { told.push([id, outcome.decision, outcome.reason ?? ""]); },
      by: () => who, nameOf: id => (id === "p-admin" ? "Chris" : id), log: () => {},
    });

    // A driver and a viewer are refused by every route, before anything is read or written.
    body = { files: { "SKILL.md": skillText("S", "Use when asked.") }, slug: "s", required: true };
    for (const who of ["driver", "viewer"] as const) {
      role = who;
      for (const route of ROUTES) assert.deepEqual(await call(route, "box=b1&slug=s"), { status: 0, body: null }, `${who}: ${route}`);
    }
    assert.equal(refusals.length, ROUTES.length * 2);
    role = "viewer";
    body = { box: "b1", skill: "weekly" };
    for (const route of MEMBER_ROUTES) assert.deepEqual(await call(route), { status: 0, body: null }, `viewer: ${route}`);
    assert.deepEqual(library.acts(), [], "nothing was written for them");
    role = "admin";
    assert.equal(await call("GET /api/org-knowledge/review"), undefined, "other routes are not this module's");

    // A personal installation has no library: every route says so.
    mode = "single-machine";
    for (const route of [...ROUTES, ...MEMBER_ROUTES]) assert.equal(((await call(route))!.body as { code: string }).code, "org-skill-personal", route);
    mode = "organisation";

    // An upload: published under its own name when none is given.
    body = { files: { "SKILL.md": skillText("DingTalk CLI", "Use when the person asks for anything in DingTalk."), "scripts/install.sh": "echo install\n" } };
    const published = (await call("POST /api/org-skills/publish"))!;
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const view = published.body as { published: string; skills: { slug: string; version: number; byName: string; source: string; required: boolean }[]; boxes: { current: number; behind: number; offline: number } };
    assert.equal(view.published, "dingtalk-cli");
    assert.deepEqual(view.skills.map(skill => [skill.slug, skill.version, skill.byName, skill.source, skill.required]), [["dingtalk-cli", 1, "Chris", "upload", false]]);
    assert.deepEqual([view.boxes.current, view.boxes.behind, view.boxes.offline], [0, 0, 2], "boxes that are down are counted as that, not as having it");
    assert.equal(((await call("POST /api/org-skills/publish"))!.body as { code: string }).code, "org-skill-unchanged");

    // The same name again with other text is an update.
    body = { slug: "dingtalk-cli", files: { "SKILL.md": skillText("DingTalk CLI", "Use when the person asks for anything in DingTalk, or to sign in.") } };
    assert.equal(((await call("POST /api/org-skills/publish"))!.body as typeof view).skills[0]!.version, 2);

    // A credential in any file is refused, and the refusal does not carry it.
    const key = `ghp_${"a1B2c3D4".repeat(5)}`;
    body = { slug: "leaky", files: { "SKILL.md": skillText("Leaky", "Use when asked."), "scripts/env.sh": `export GH=${key}\n` } };
    const leaky = (await call("POST /api/org-skills/publish"))!;
    assert.equal(leaky.status, 400);
    assert.equal((leaky.body as { code: string }).code, "org-skill-credential");
    assert.doesNotMatch(JSON.stringify(leaky.body), new RegExp(key));

    // From a box the Admin may enter: its files, under its own slug; a box they may not enter is not read.
    body = { box: "b1", skill: "weekly" };
    assert.deepEqual(((await call("GET /api/org-skills/box", "box=b1"))!.body as { skills: string[] }).skills, ["weekly"]);
    assert.equal((await call("POST /api/org-skills/publish"))!.status, 200);
    assert.deepEqual(library.filesOf(library.get("weekly")!), { "SKILL.md": boxFiles["/w/skills/weekly/SKILL.md"], "scripts/run.sh": "echo week\n" });
    assert.equal(library.get("weekly")!.source, "box:b1/weekly");
    body = { box: "b2", skill: "weekly" };
    assert.equal(((await call("POST /api/org-skills/publish"))!.body as { code: string }).code, "org-skill-box");
    body = { box: "b1", skill: "../../etc" };
    assert.equal(((await call("POST /api/org-skills/publish"))!.body as { code: string }).code, "org-skill-box");

    // From a template document: one of its skills, by slug.
    body = { skill: "expenses", template: { format: "lumenbox-template/1", profile: { name: "Finance", description: "d", role: "r" }, skills: [{ slug: "expenses", name: "Expenses", description: "Use when filing expenses.", files: { "SKILL.md": skillText("Expenses", "Use when filing expenses.") } }] } };
    const fromTemplate = (await call("POST /api/org-skills/publish"))!;
    assert.equal(fromTemplate.status, 200, JSON.stringify(fromTemplate.body));
    assert.equal(library.get("expenses")!.source, "template:Finance");
    body = {};
    assert.equal(((await call("POST /api/org-skills/publish"))!.body as { code: string }).code, "org-skill-source");

    // Required, and withdrawn; each is a line with who did it.
    body = { slug: "expenses", required: true };
    assert.equal(((await call("POST /api/org-skills/require"))!.body as typeof view).skills.find(skill => skill.slug === "expenses")!.required, true);
    body = { slug: "weekly" };
    assert.deepEqual(((await call("POST /api/org-skills/withdraw"))!.body as typeof view).skills.map(skill => skill.slug), ["dingtalk-cli", "expenses"]);
    assert.equal((await call("POST /api/org-skills/withdraw"))!.status, 404, "what is not published cannot be withdrawn");
    const history = (await call("GET /api/org-skills/history", "slug=weekly"))!.body as { acts: { act: string; byName: string }[] };
    assert.deepEqual(history.acts.map(act => [act.act, act.byName]), [["publish", "Chris"], ["withdraw", "Chris"]]);
    assert.equal((await call("POST /api/org-skills/nothing"))!.status, 404);

    // A member offers a skill from their box: held, placed nowhere, and an Admin sees exactly what they would publish.
    role = "driver"; who = "p-ann";
    boxFiles["/w/skills/standup/SKILL.md"] = skillText("Standup", "Use when the team's morning standup notes are asked for.");
    boxFiles["/w/skills/standup/scripts/collect.sh"] = "echo collect\n";
    body = { box: "b1", skill: "standup" };
    const offered = (await call("POST /api/org-skills/offer"))!;
    assert.equal(offered.status, 200, JSON.stringify(offered.body));
    const offerId = (offered.body as { offer: { id: string; state: string } }).offer.id;
    assert.equal(library.get("standup"), undefined, "an offer is not a skill until an Admin says so");
    assert.equal(((await call("POST /api/org-skills/offer"))!.body as { code: string }).code, "org-skill-unchanged", "the same offer twice is one offer");
    boxFiles["/w/skills/leaky/SKILL.md"] = skillText("Leaky", `Use when asked. ${key}`);
    body = { box: "b1", skill: "leaky" };
    assert.equal(((await call("POST /api/org-skills/offer"))!.body as { code: string }).code, "org-skill-credential", "a credential is refused at the offer, not kept for review");
    assert.deepEqual(((await call("GET /api/org-skills/offers/mine"))!.body as { offers: { slug: string; state: string }[] }).offers.map(offer => [offer.slug, offer.state]), [["standup", "waiting"]]);
    assert.deepEqual(await call("GET /api/org-skills/offers"), { status: 0, body: null }, "a member does not read the review");
    body = { id: offerId, decision: "approved" };
    assert.deepEqual(await call("POST /api/org-skills/offers/decide"), { status: 0, body: null }, "and does not decide their own offer");

    role = "admin"; who = "p-admin";
    const review = (await call("GET /api/org-skills/offers"))!.body as { offers: { id: string; byName: string; content: Record<string, string>; check: { ok: boolean }; warnings: string[]; replaces: number | null }[] };
    assert.equal(review.offers.length, 1);
    assert.deepEqual(Object.keys(review.offers[0]!.content).sort(), ["SKILL.md", "scripts/collect.sh"], "the files, as they would be published");
    assert.deepEqual([review.offers[0]!.check.ok, review.offers[0]!.replaces], [true, null]);
    body = { id: offerId, decision: "declined" };
    assert.equal(((await call("POST /api/org-skills/offers/decide"))!.body as { code: string }).code, "org-skill-invalid", "declining needs a reason: the member is told it");
    body = { id: offerId, decision: "approved" };
    assert.equal((await call("POST /api/org-skills/offers/decide"))!.status, 200);
    assert.deepEqual([library.get("standup")!.by, library.get("standup")!.version], ["p-admin", 1], "publishing is the Admin's act");
    assert.match(library.get("standup")!.source, new RegExp(`^offer:${offerId} from p-ann `));
    assert.equal((await call("POST /api/org-skills/offers/decide"))!.status, 404, "decided once");

    // Declined, with the reason the member reads.
    role = "driver"; who = "p-ann";
    boxFiles["/w/skills/standup/SKILL.md"] = skillText("Standup", "Use when the team's morning standup notes are asked for, in any language.");
    body = { box: "b1", skill: "standup" };
    const second = ((await call("POST /api/org-skills/offer"))!.body as { offer: { id: string } }).offer.id;
    role = "admin"; who = "p-admin";
    assert.equal(((await call("GET /api/org-skills/offers"))!.body as typeof review).offers[0]!.replaces, 1, "the review says it would replace version 1");
    body = { id: second, decision: "declined", reason: "the first version is the one we agreed" };
    assert.equal((await call("POST /api/org-skills/offers/decide"))!.status, 200);
    assert.equal(library.get("standup")!.version, 1, "declined: nothing was published");
    role = "driver"; who = "p-ann";
    const mine = ((await call("GET /api/org-skills/offers/mine"))!.body as { offers: { state: string; reason?: string; decidedByName?: string }[] }).offers;
    assert.deepEqual(mine.map(offer => [offer.state, offer.reason ?? "", offer.decidedByName]), [["approved", "", "Chris"], ["declined", "the first version is the one we agreed", "Chris"]]);
    assert.deepEqual(told, [["p-ann", "approved", ""], ["p-ann", "declined", "the first version is the one we agreed"]], "the member is told each outcome");
    assert.deepEqual(library.acts().filter(act => act.offer !== undefined).map(act => [act.act, act.by, act.decision ?? ""]), [
      ["offer", "p-ann", ""], ["publish", "p-admin", ""], ["decide", "p-admin", "approved"], ["offer", "p-ann", ""], ["decide", "p-admin", "declined"],
    ], "and every step is on the ledger with who took it");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
