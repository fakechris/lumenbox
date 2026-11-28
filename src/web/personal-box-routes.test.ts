/**
 * Handing a personal box over (INV-2298, docs/111 §1 rule 1 and §3): an Admin never makes a
 * member's box theirs; while its owner can sign in it changes hands only with their yes; once they
 * have left an Admin hands it to a successor; every act is written to the administration ledger
 * before it takes effect, and an act whose line cannot be written does not happen.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxEntry } from "../box/boxes.ts";
import { ADMINISTRATION_LEDGER, administrationLedger, type WriteAdminAct } from "../host/admin-ledger.ts";
import { PersonalBoxes } from "../host/personal-boxes.ts";
import { Principals, type Principal } from "../host/principals.ts";
import { apiError } from "./api-error.ts";
import { boxRules, personalBoxRoute, planBoxDispositions } from "./personal-box-routes.ts";

test("an Admin cannot take a member's box; the owner's yes hands it over; after they leave an Admin may; every act is written first", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-personal-box-routes-"));
  try {
    const people: Principal[] = [
      { id: "admin", name: "Ada", role: "admin", identities: ["web:admin"] },
      { id: "bea", name: "Bea", role: "driver", identities: ["web:bea"] },
      { id: "cy", name: "Cy", role: "driver", identities: ["web:cy"] },
    ];
    const principals = new Principals(join(home, "principals.json"));
    principals.save(people);
    const entries: BoxEntry[] = [];
    const boxes = new PersonalBoxes({
      home: join(home, "personal-boxes"), entries: () => entries, quota: () => undefined, authorize: () => true, residents: () => 0,
      attach: entry => { entries.splice(0, entries.length, ...entries.filter(row => row.id !== entry.id), entry); },
      detach: id => { entries.splice(0, entries.length, ...entries.filter(row => row.id !== id)); },
      driver: { start: async () => "http://127.0.0.1:9", remove: async () => {} },
    });
    const bea = (await boxes.create("bea", "first", () => true, { ownerName: "Bea" })).id;
    const ledger = administrationLedger(home);
    const lines = () => readFileSync(join(home, ADMINISTRATION_LEDGER), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, string>);
    const told: string[] = [];
    let record: WriteAdminAct = ledger;
    const call = async (route: string, identity: string | undefined, body: Record<string, unknown>) => {
      let reply = { status: 0, body: undefined as unknown };
      await personalBoxRoute(route, {
        boxes, principals, identity, quota: () => undefined, authorize: () => true, connections: () => undefined, residents: () => [], reconnect: async () => {},
        read: async () => body, send: (status, sent) => { reply = { status, body: sent }; }, error: apiError, record, tell: (id, words) => told.push(`${id} ${words}`),
      });
      return reply;
    };
    const admin = (body: Record<string, unknown>) => call("POST /api/personal-boxes/admin", "web:admin", body);
    const ownerOf = (id: string) => boxes.inventory().find(row => row.id === id)?.owner;

    const self = await admin({ id: bea, action: "transfer", recipient: "admin" });
    assert.deepEqual([self.status, (self.body as { code: string }).code], [403, "personal-box-transfer-self"], "an Admin may not make a member's box theirs");
    assert.equal(ownerOf(bea), "bea");

    // Bea can still sign in: the Admin's transfer is a request, and nothing changes hands until she says yes.
    assert.equal((await admin({ id: bea, action: "transfer", recipient: "cy", reason: "Cy takes over the accounts" })).status, 202);
    assert.equal(ownerOf(bea), "bea", "a request is not a hand-over");
    assert.deepEqual(boxes.list("bea")[0]?.transferAsked && { to: boxes.list("bea")[0]!.transferAsked!.to, by: boxes.list("bea")[0]!.transferAsked!.by }, { to: "cy", by: "admin" }, "her page shows what was asked");
    assert.equal((await call("POST /api/personal-boxes/transfer-answer", "web:bea", { id: bea, agree: false })).status, 200);
    assert.equal(ownerOf(bea), "bea", "a no keeps it hers");
    assert.equal((await admin({ id: bea, action: "transfer", recipient: "cy", reason: "Cy takes over the accounts" })).status, 202);
    assert.equal((await call("POST /api/personal-boxes/transfer-answer", "web:bea", { id: bea, agree: true })).status, 200);
    assert.equal(ownerOf(bea), "cy", "her yes hands it over");
    assert.equal(boxes.list("cy")[0]?.handedFrom?.name, "Bea", "Cy's row says whose sign-ins may still be in it");
    assert.deepEqual(told, ["bea asked", "admin declined", "bea asked", "cy handed"]);

    // Cy leaves (a sync took his last sign-in): an Admin hands his box to a successor without him.
    principals.save(people.map(person => person.id === "cy" ? { ...person, role: "viewer" as const, identities: [] } : person));
    assert.equal((await admin({ id: bea, action: "transfer", recipient: "bea", reason: "Cy left" })).status, 200);
    assert.equal(ownerOf(bea), "bea");

    for (const action of ["keep", "recover", "delete"]) assert.equal((await admin({ id: bea, action, agentIds: [] })).status, 200, action);
    const spare = (await boxes.create("bea", "spare", () => true, { ownerName: "Bea" })).id;
    assert.equal((await call("POST /api/personal-boxes/admin-cleanup", "web:admin", { id: spare, deleteData: true })).status, 200);
    assert.deepEqual(lines().map(line => [line.act, line.by, line.from, line.to ?? ""]), [
      ["personal-box.transfer-asked", "admin", "bea", "cy"],
      ["personal-box.transfer-declined", "bea", "bea", "cy"],
      ["personal-box.transfer-asked", "admin", "bea", "cy"],
      ["personal-box.transfer", "bea", "bea", "cy"],
      ["personal-box.transfer", "admin", "cy", "bea"],
      ["personal-box.keep", "admin", "bea", ""],
      ["personal-box.recover", "admin", "bea", ""],
      ["personal-box.delete", "admin", "bea", ""],
      ["personal-box.cleanup", "admin", "bea", ""],
    ], "every act, before it took effect, with who, which box, from whom to whom");
    assert.equal(lines()[3]!.askedBy, "admin", "a hand-over she agreed to names who asked");
    assert.equal(lines()[4]!.reason, "Cy left");
    assert.ok(lines().every(line => line.box !== undefined && line.at !== undefined));

    // A line that cannot be written refuses the act.
    const kept = (await boxes.create("bea", "kept", () => true, { ownerName: "Bea" })).id;
    record = () => { throw new Error("disk full"); };
    const refused = await admin({ id: kept, action: "keep" });
    assert.deepEqual([refused.status, (refused.body as { code: string }).code], [503, "admin-ledger-failed"]);
    assert.equal(boxes.list("bea").find(row => row.id === kept)?.status, "ready", "nothing was done");

    // Removing a member: their computers do not go to the Admin removing them, and the plan is written before anything moves.
    principals.save(people);
    const rules = boxRules({ agentsIn: () => [], list: () => [] }, () => []);
    const plan = (recipient: string, write: WriteAdminAct) => planBoxDispositions(boxes, people[1]!, people.filter(person => person.id !== "bea"),
      { action: "transfer", recipient, boxIds: boxes.list("bea").map(row => row.id) }, () => undefined, () => true, rules, { identity: "web:admin", record: write });
    assert.throws(() => plan("admin", ledger), /themselves/);
    assert.throws(() => plan("cy", record), /could not be written/);
    assert.equal(boxes.list("bea").length, 1, "a refused plan moved nothing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
