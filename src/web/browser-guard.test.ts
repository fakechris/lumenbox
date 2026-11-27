/**
 * What a browser's request must be to change something (docs/106 §5 R5, INV-2204). The server's
 * use of this is tested on a real socket in exposure.test.ts; here is every case of the rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { originOf, originRefusal, securityHeaders } from "./browser-guard.ts";

const request = (method: string, headers: Record<string, string>, url = "/api/tasks") => ({ method, headers, url });

test("a request that changes something comes from this installation's own page; a program's, a webhook's and a read are not asked", () => {
  const OURS = "https://box.example.test";
  const local = { host: "127.0.0.1:7777" };

  // Off local: the declared address, and nothing else.
  assert.equal(originRefusal(request("POST", { host: "box.example.test", origin: OURS }), OURS), undefined);
  assert.equal(originRefusal(request("POST", { host: "box.example.test", origin: "https://evil.example" }), OURS), "cross-origin");
  assert.equal(originRefusal(request("DELETE", { host: "box.example.test", origin: "http://box.example.test" }), OURS), "cross-origin", "the same name over plain HTTP is another origin");
  assert.equal(originRefusal(request("POST", { host: "evil.example", origin: "https://evil.example" }), OURS), "cross-origin", "agreeing with a Host the sender chose is not enough when the address is declared");
  assert.equal(originRefusal(request("POST", { host: "box.example.test", origin: "null" }), OURS), "cross-origin", "a sandboxed frame is nobody's page");
  assert.equal(originRefusal(request("POST", { host: "box.example.test", referer: `${OURS}/?view=settings` }), OURS), undefined, "without an Origin the Referer says where it came from");
  assert.equal(originRefusal(request("POST", { host: "box.example.test", referer: "https://evil.example/page" }), OURS), "cross-origin");

  // Local: whatever address the request itself was sent to — the app's 127.0.0.1, a browser's localhost.
  assert.equal(originRefusal(request("POST", { ...local, origin: "http://127.0.0.1:7777" }), undefined), undefined);
  assert.equal(originRefusal(request("POST", { host: "localhost:7777", origin: "http://localhost:7777" }), undefined), undefined);
  assert.equal(originRefusal(request("POST", { host: "localhost", origin: "http://localhost" }), undefined), undefined);
  assert.equal(originRefusal(request("POST", { ...local, origin: "http://127.0.0.1:3000" }), undefined), "cross-origin", "another port on this machine is another site");
  assert.equal(originRefusal(request("POST", { ...local, origin: "https://evil.example" }), undefined), "cross-origin");

  // Reached over https with no address declared: the same name over plain HTTP is not ours.
  assert.equal(originRefusal(request("POST", { host: "box.example.test", origin: "http://box.example.test" }), undefined, false, true), "cross-origin");
  assert.equal(originRefusal(request("POST", { host: "box.example.test", origin: "https://box.example.test" }), undefined, false, true), undefined);

  // Not asked, and why.
  assert.equal(originRefusal(request("GET", { ...local, origin: "https://evil.example" }), undefined), undefined, "a read changes nothing, and a link from anywhere opens the page");
  assert.equal(originRefusal(request("POST", { ...local, origin: "https://evil.example", authorization: "Bearer x" }), OURS), undefined, "a bearer credential is a program's: no page can add that header unasked");
  assert.equal(originRefusal(request("POST", local), OURS), undefined, "no Origin and no Referer is not a browser");
  assert.equal(originRefusal(request("POST", { ...local, origin: "https://ci.example" }, "/hooks/abc123def"), OURS), undefined, "a webhook is called from anywhere and carries its own secret");
  assert.equal(originRefusal(request("POST", { ...local, origin: "https://evil.example" }, "/hooks/abc123def/extra"), OURS), "cross-origin", "only the webhook itself");

  // A socket upgrade is a GET that is not a read.
  assert.equal(originRefusal(request("GET", { ...local, origin: "https://evil.example" }, "/desktop/1/websockify"), undefined, true), "cross-origin");
  assert.equal(originRefusal(request("GET", { ...local, origin: "http://127.0.0.1:7777" }, "/desktop/1/websockify"), undefined, true), undefined);
  assert.equal(originRefusal(request("GET", { host: "box.example.test", origin: OURS }, "/desktop/1/websockify"), OURS, true), undefined);

  assert.equal(originOf(" https://box.example.test/path/ "), OURS);
  assert.equal(originOf("box.example.test"), undefined);
  assert.equal(originOf(undefined), undefined);
});

test("the page's headers keep it from being framed, from posting or connecting elsewhere and from loading a plugin; scripts and styles are not strict yet", () => {
  const headers = securityHeaders({ headers: { host: "127.0.0.1:7777" } }, undefined);
  const policy = Object.fromEntries(headers["content-security-policy"]!.split("; ").map(directive => { const [name, ...values] = directive.split(" "); return [name, values.join(" ")]; }));
  assert.equal(policy["frame-ancestors"], "'self'");
  assert.equal(policy["object-src"], "'none'");
  assert.equal(policy["base-uri"], "'self'");
  assert.equal(policy["form-action"], "'self'");
  assert.equal(policy["default-src"], "'self'");
  assert.equal(policy["connect-src"], "'self' ws://127.0.0.1:7777 wss://127.0.0.1:7777", "here, and the desktop's socket here");
  // What is honest about today: the page is written inline, so this does not stop an injected script.
  // When the page stops needing it, this line changes and the policy becomes a defence against injection.
  assert.equal(policy["script-src"], "'self' 'unsafe-inline'");
  assert.ok(!headers["content-security-policy"]!.includes("unsafe-eval"));
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["referrer-policy"], "same-origin");
  assert.match(securityHeaders({ headers: { host: "evil; script-src *" } }, undefined)["content-security-policy"]!, /connect-src 'self';/, "a Host that is not a host adds nothing to the policy");
  assert.match(securityHeaders({ headers: { host: "10.0.0.5:7777" } }, "https://box.example.test")["content-security-policy"]!, /connect-src 'self' ws:\/\/box\.example\.test wss:\/\/box\.example\.test;/);
});
