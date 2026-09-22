import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeHelper } from "./native-helper.ts";

const launch = (source: string, options: Parameters<typeof nativeHelper>[3] = {}) =>
  nativeHelper(process.execPath, ["-e", source], { value: "fixture-private-text" }, options);

test("native helper bounds hangs and output; failure messages never include request values or stderr", async () => {
  await assert.rejects(launch("setInterval(()=>{},1000)", { timeoutMs: 50 }), /deadline exceeded/);
  await assert.rejects(launch("process.stdout.write('x'.repeat(10000))", { maxBytes: 100 }), /output limit/);
  await assert.rejects(launch("process.stderr.write('fixture-private-text');process.exit(1)"), error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /fixture-private-text/);
    return /without a receipt/.test(error.message);
  });
  assert.equal(await launch("process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('healthy'))"), "healthy", "next process survives the previous crash");
});

test("revoking authority terminates a hung native operation and prevents a new launch", async () => {
  let allowed = true;
  const authorize = () => { if (!allowed) throw new Error("revoked"); };
  const operation = launch("setInterval(()=>{},1000)", { authorize, timeoutMs: 2000 });
  allowed = false;
  await assert.rejects(operation, /authority revoked/);
  assert.throws(() => launch("process.exit(0)", { authorize }), /revoked/);
});
