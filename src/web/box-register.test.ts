/**
 * A runner registering through the real server (INV-434): a code from an admin, a box
 * that appears with a state, a replay refused, a reconnect that is the same box, a
 * revocation that cuts it off and says what it cannot promise — with no code and no
 * credential in the log.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";
import { writeSixIdentities } from "../host/testing/six-identities.ts";

const PORT = 7933;
const BASE = `http://127.0.0.1:${PORT}`;

test("connect code → register → listed with a state; replay 409; reconnect idempotent; revoke refuses and is honest", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-box-register-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  // A personal installation: an organisation takes no box by a code (INV-1697; node-enrol.test.ts).
  writeFileSync(join(home, "principals.json"), JSON.stringify({ principals: [{ id: "local:owner", name: "Owner", role: "admin", identities: [] }], installation: { mode: "single-machine", ownerId: "local:owner" } }));
  const logs: string[] = [];
  let stop: (() => void) | undefined;
  try {
    stop = await startWebServer({ port: PORT, host: "127.0.0.1", token: "t0k", useBox: false, onLog: line => logs.push(line) });
    const ui = { "content-type": "application/json", authorization: "Bearer t0k" };
    const admin = (path: string, body?: unknown) => fetch(`${BASE}${path}`, { method: body === undefined ? "GET" : "POST", headers: ui, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const runner = (body: unknown) => fetch(`${BASE}/api/boxes/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const minted = (await (await admin("/api/boxes/connect-codes", { name: "lab-2" })).json()) as { code: string; expiresAt: string };
    assert.match(minted.code, /^lbx-/);
    const pending = (await (await admin("/api/boxes/connect-codes")).json()) as { pending: { name?: string }[] };
    assert.equal(pending.pending[0]?.name, "lab-2");
    assert.equal(JSON.stringify(pending).includes(minted.code), false, "the list never carries the code");

    // Registration without a session: the code is the credential. The daemon at that
    // address is not running, so the box registers offline — and says so.
    const registered = await runner({ code: minted.code, baseUrl: "http://127.0.0.1:1/", token: "daemon-token-0123456789", version: "0.2.1" });
    const registeredText = await registered.text();
    assert.equal(registered.status, 200, registeredText);
    const reg = JSON.parse(registeredText) as { boxId: string; name: string; runner: string; connected: boolean; state: string };
    assert.equal(reg.name, "lab-2");
    assert.match(reg.runner, /^lbxr_/);
    assert.equal(reg.state, "offline");

    const boxes = (await (await admin("/api/boxes")).json()) as { boxes: { id: string; name: string; state?: string; version?: string }[] };
    const lab = boxes.boxes.find(box => box.id === reg.boxId);
    assert.equal(lab?.state, "offline");
    assert.equal(lab?.version, "0.2.1");

    // A2: replay of the spent code, and a foreign code.
    assert.equal((await runner({ code: minted.code, name: "again", baseUrl: "http://127.0.0.1:1/", token: "x".repeat(20) })).status, 409);
    assert.equal((await runner({ code: "lbx-deadbeef-xyz", name: "foreign", baseUrl: "http://127.0.0.1:1/", token: "x".repeat(20) })).status, 403);

    // A3: reconnect with the runner credential is the same box, at a new address.
    const moved = await runner({ runner: reg.runner, baseUrl: "http://127.0.0.1:2/", token: "daemon-token-0123456789", version: "0.2.2" });
    assert.equal(moved.status, 200);
    assert.equal(((await moved.json()) as { boxId: string }).boxId, reg.boxId);
    const after = (await (await admin("/api/boxes")).json()) as { boxes: { id: string; endpoint?: string; version?: string }[] };
    assert.equal(after.boxes.filter(box => box.id === reg.boxId).length, 1, "one box, not two");
    assert.equal(after.boxes.find(box => box.id === reg.boxId)?.endpoint, "http://127.0.0.1:2");
    assert.equal(after.boxes.find(box => box.id === reg.boxId)?.version, "0.2.2");
    assert.equal((await runner({ runner: "lbxr_nope", baseUrl: "http://127.0.0.1:2/", token: "x".repeat(20) })).status, 401);

    // A4: revoked — refuses reconnects, says what it cannot promise.
    const revoked = (await (await admin("/api/boxes/revoke", { box: "lab-2" })).json()) as { revoked: string; agentsLiving: number; note: string };
    assert.equal(revoked.revoked, reg.boxId);
    assert.match(revoked.note, /takes no new connections or work from here/);
    assert.match(revoked.note, /Stop the runner on its own machine to be sure/);
    assert.equal((await runner({ runner: reg.runner, baseUrl: "http://127.0.0.1:2/", token: "daemon-token-0123456789" })).status, 403);
    const final = (await (await admin("/api/boxes")).json()) as { boxes: { id: string; state?: string }[] };
    assert.equal(final.boxes.find(box => box.id === reg.boxId)?.state, "revoked");

    // A5: nothing secret in the log.
    const joined = logs.join("\n");
    assert.ok(!joined.includes(minted.code) && !joined.includes(reg.runner) && !joined.includes("daemon-token-0123456789"), "no code, credential or daemon token in the log");
    assert.ok(joined.includes("registered with a connection code"));
  } finally {
    stop?.();
    process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

// Chris's desktop before the INV-1698 merge: six identities, no `installation` field. On the desktop
// it is the personal installation not yet merged and keeps joining its VMs by a code; a server with
// the same roster is an organisation and takes none (INV-1697, docs/96 §8 Q3).
test("desktop with no installation field takes a connection code; a server with the same roster refuses it", async () => {
  for (const desktop of [true, false]) {
    const home = mkdtempSync(join(tmpdir(), "inv1697-six-"));
    const previous = process.env.AGENTBOX_HOME;
    process.env.AGENTBOX_HOME = home;
    writeSixIdentities(home, { ledgers: false, boxes: false });
    let stop: (() => void) | undefined;
    try {
      let base = "";
      stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", useBox: false, desktop, onLog: () => {}, onReady: url => { base = url; } });
      const minted = await fetch(`${base}/api/boxes/connect-codes`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t0k" }, body: JSON.stringify({ name: "grok" }) });
      const ways = (await (await fetch(`${base}/api/boxes/register`)).json()) as { installation: string };
      if (desktop) {
        assert.equal(minted.status, 200, "the desktop mints a code");
        assert.equal(ways.installation, "single-machine", "and box connect is told it is personal");
        const { code } = (await minted.json()) as { code: string };
        const registered = await fetch(`${base}/api/boxes/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, baseUrl: "http://127.0.0.1:1/", token: "daemon-token-0123456789" }) });
        assert.equal(registered.status, 200, "and the VM joins by it");
        assert.equal(JSON.parse(readFileSync(join(home, "principals.json"), "utf8")).installation, undefined, "nothing decided the merge for the person");
      } else {
        assert.equal(minted.status, 409);
        assert.equal(((await minted.json()) as { code: string }).code, "box-code-organisation");
        assert.equal(ways.installation, "organisation");
      }
    } finally {
      stop?.();
      process.env.AGENTBOX_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  }
});
