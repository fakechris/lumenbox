/**
 * Tests for reading the web.
 *
 * The weight is on refusal rather than retrieval, because retrieval failing is visible
 * and refusal failing is not: a page an agent should never have reached comes back
 * looking exactly like a page it should have. The pages an agent reads are written by
 * strangers, and "fetch http://169.254.169.254/..." on one of them is an instruction
 * aimed at the agent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockedBy,
  fetchPage,
  forbiddenAddress,
  guardUrl,
  htmlToText,
  isSearchEngine,
  searchWeb,
  SEARCH_KEY_VARIABLE,
} from "./web.ts";

test("addresses that mean 'somewhere inside' are named as such, in both families", () => {
  // The reason this exists at all: cloud instance credentials.
  assert.match(forbiddenAddress("169.254.169.254") ?? "", /credentials/);
  assert.match(forbiddenAddress("127.0.0.1") ?? "", /this machine/);
  assert.match(forbiddenAddress("::1") ?? "", /this machine/);
  // Carrier-grade NAT stays blocked: it is what Tailscale hands out, so it really is
  // somebody's private network.
  for (const inside of [
    "10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.1", "fd00::1", "fe80::1", "100.100.0.1",
  ]) {
    assert.ok(forbiddenAddress(inside) !== undefined, inside);
  }
  // An IPv4 address wearing an IPv6 costume is the same address.
  assert.match(forbiddenAddress("::ffff:127.0.0.1") ?? "", /this machine/);
  assert.match(forbiddenAddress("::ffff:169.254.169.254") ?? "", /credentials/);

  // And the ranges *beside* the private ones are ordinary internet, or the check would
  // quietly cost the agent most of the web.
    // 198.18/15 among them: a transparent proxy hands these back for ordinary public
  // names, and treating it as inside costs every site on such a machine.
  for (const outside of [
    "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.167.1.1", "1.1.1.1", "2606:4700::1", "198.18.2.37",
  ]) {
    assert.equal(forbiddenAddress(outside), undefined, outside);
  }
});

test("loopback and non-web schemes are refused before a socket is opened", async () => {
  // Port 9 is discard; nothing should listen, and nothing should try — the refusal has
  // to come from the address, not from a failed connection.
  await assert.rejects(fetchPage("http://127.0.0.1:9/secrets"), /this machine/);
  await assert.rejects(fetchPage("http://[::1]:9/secrets"), /this machine/);
  await assert.rejects(fetchPage("http://169.254.169.254/latest/meta-data/"), /credentials/);
  // The host's disk is the one machine an agent is deliberately not on.
  await assert.rejects(fetchPage("file:///etc/passwd"), /not a scheme/);
  await assert.rejects(fetchPage("not a url"), /not a URL/);
});

/** A stand-in transport, so the redirect and body handling can be exercised offline. */
const serving = (pages: Record<string, { status?: number; type?: string; body?: string; to?: string }>) =>
  async (target: URL) => {
    const page = pages[target.toString()];
    if (page === undefined) throw new Error(`test asked for an unserved url: ${target}`);
    return {
      status: page.status ?? (page.to !== undefined ? 302 : 200),
      headers: {
        ...(page.to !== undefined ? { location: page.to } : {}),
        "content-type": page.type ?? "text/html",
      },
      body: Buffer.from(page.body ?? ""),
      truncated: false,
    };
  };

test("a redirect chain is followed, and where it ended is what comes back", async () => {
  const page = await fetchPage(
    "https://example.test/start",
    serving({
      "https://example.test/start": { to: "/middle" },
      "https://example.test/middle": { to: "https://elsewhere.test/end" },
      "https://elsewhere.test/end": { body: "<title>Arrived</title><p>the content</p>" },
    })
  );
  // Reporting the URL asked for rather than the one that answered is how an agent cites
  // a source it never read.
  assert.equal(page.url, "https://elsewhere.test/end");
  assert.equal(page.title, "Arrived");
  assert.match(page.text, /the content/);
});

test("a redirect loop stops, and says where it went rather than just 'failed'", async () => {
  await assert.rejects(
    fetchPage(
      "https://example.test/a",
      serving({ "https://example.test/a": { to: "/b" }, "https://example.test/b": { to: "/a" } })
    ),
    /redirected more than 5 times/
  );
});

test("an error status is an error, not a page whose text is the error page", async () => {
  await assert.rejects(
    fetchPage("https://example.test/gone", serving({ "https://example.test/gone": { status: 404 } })),
    /HTTP 404/
  );
});

test("HTML becomes something readable, keeping the parts an agent acts on", () => {
  const { title, text } = htmlToText(`
    <html><head><title> Some  Page </title>
      <style>.a{color:red}</style><script>alert("nope")</script></head>
    <body>
      <h2>Findings</h2>
      <p>First&nbsp;paragraph &amp; some &#8212; punctuation.</p>
      <ul><li>one</li><li>two</li></ul>
      <a href="https://example.test/next">Read on</a>
      <a href="#top">Back to top</a>
      <a href="javascript:void(0)">Menu</a>
    </body></html>`);

  assert.equal(title, "Some Page");
  // Script and style are dropped with their contents — a page's JavaScript is not prose,
  // and it is where an injected instruction would rather be than in the visible text.
  assert.doesNotMatch(text, /nope|color:red/);
  // Structure the model reads meaning from survives.
  assert.match(text, /## Findings/);
  assert.match(text, /- one\n- two/);
  assert.match(text, /First paragraph & some — punctuation\./);
  // A link is the next thing to fetch, so it keeps its address.
  assert.match(text, /\[Read on\]\(https:\/\/example\.test\/next\)/);
  // Ones that go nowhere from here keep their words and lose the link.
  assert.match(text, /Back to top/);
  assert.doesNotMatch(text, /#top|javascript:/);
});

test("a page too long to send is cut, and says it was cut", async () => {
  const page = await fetchPage(
    "https://example.test/long",
    serving({ "https://example.test/long": { type: "text/plain", body: "x".repeat(60_000) } })
  );
  assert.equal(page.truncated, true);
  assert.match(page.text, /rest of page not shown/);
  assert.ok(page.text.length < 41_000, `${page.text.length}`);
});

test("searching with no key configured says so, rather than failing as if nothing exists", async () => {
  const previous = process.env[SEARCH_KEY_VARIABLE];
  delete process.env[SEARCH_KEY_VARIABLE];
  try {
    // The distinction that matters: an agent that cannot tell "no results" from "not
    // configured" reports confidently that a thing does not exist.
    await assert.rejects(searchWeb("anything"), new RegExp(SEARCH_KEY_VARIABLE));
  } finally {
    if (previous !== undefined) process.env[SEARCH_KEY_VARIABLE] = previous;
  }
});

test("a block page is a failure, not an empty answer", async () => {
  // The exact shape that caused a real wrong answer: HTTP 200, a title, prose. An agent
  // read it as "this chip does not exist anywhere" and reconciled the gap by inventing.
  const google =
    "<title>Google Search</title><body>If you're having trouble accessing Google " +
    "Search, please click here, or send feedback.</body>";
  await assert.rejects(
    fetchPage("https://example.test/s", async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from(google),
      truncated: false,
    })),
    /block or consent screen/
  );
  // And it must say what to do instead, or the agent simply gives up here.
  await assert.rejects(
    fetchPage("https://example.test/s", async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from(google),
      truncated: false,
    })),
    /browser_open/
  );

  for (const wall of [
    "<body>Just a moment...</body>",
    "<body>Enable JavaScript and cookies to continue</body>",
    "<body>Verify you are human</body>",
    "<body>Attention Required! Access denied</body>",
  ]) {
    assert.ok(blockedBy(htmlToText(wall).text) !== undefined, wall);
  }
});

test("a real article that merely mentions blocking is not treated as blocked", () => {
  // The false positive that would matter: an agent told a page was a block screen stops
  // reading a page that was fine. Length is what separates them — a block page is short
  // because there is nothing on it.
  const article = (
    "Cloudflare's interstitial says 'checking your browser' while it runs its " +
    "challenge. "
  ).repeat(40);
  assert.equal(blockedBy(article), undefined);
  assert.ok(article.length > 1500);
});

test("a status code is never handed over bare, because it gets reasoned from", async () => {
  const status = (code: number) =>
    fetchPage("https://example.test/x", async () => ({
      status: code,
      headers: {},
      body: Buffer.from(""),
      truncated: false,
    }));
  // An agent read a 401 as proof a repository existed and was merely private, and built
  // a claim on it. Sites answer 401 for absent pages too.
  await assert.rejects(status(401), /says nothing about whether the page exists/);
  await assert.rejects(status(404), /may be one you guessed/);
  await assert.rejects(status(429), /rate-limited, not told the page is absent/);
});

test("search engines are named as the wrong tool, not left to fail as a fetch", () => {
  assert.ok(isSearchEngine("https://www.google.com/search?q=thor+t5000"));
  assert.ok(isSearchEngine("https://duckduckgo.com/?q=x"));
  assert.ok(isSearchEngine("https://www.baidu.com/s?wd=x"));
  // A page that merely lives on a search engine's domain is an ordinary page.
  assert.ok(!isSearchEngine("https://www.google.com/about/"));
  assert.ok(!isSearchEngine("https://example.com/search?q=x"));
});

test("what `file:` means depends on which machine is asking", async () => {
  // On the host it reads the operator's disk — the one machine an agent is deliberately
  // not on — so a fetch refuses it.
  await assert.rejects(guardUrl("file:///etc/passwd"), /not a scheme this opens/);
  await assert.rejects(guardUrl("data:text/html,<h1>x</h1>"), /not a scheme this opens/);

  // In the box it is the agent's own filesystem, which it can already read and write with
  // its file tools. Refusing it there only stops it looking at a report it just wrote.
  const local = await guardUrl("file:///home/box/work/report.html", true);
  assert.equal(local.protocol, "file:");
  assert.equal((await guardUrl("data:text/html,<h1>x</h1>", true)).protocol, "data:");

  // The address guard still applies to anything with a host to resolve, either way.
  await assert.rejects(guardUrl("http://169.254.169.254/latest/", true), /credentials/);
});
