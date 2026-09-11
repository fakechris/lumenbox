/**
 * Tests for Audit UI formatting, sanitization, noise filtering, and provenance badging (INV-441).
 *
 * Verifies that:
 * 1. Timestamp and command text do not concatenate into plain text copies.
 * 2. Escape codes and ANSI sequences are sanitized safely.
 * 3. Supervisor recurring health probes are detected and tagged with .probe for filtering.
 * 4. Sources are accurately badged as [USER], [AGENT], or [SYSTEM].
 *
 * Extracted directly from APP_HTML to ensure tests assert against the exact code shipping to browsers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_HTML } from "./app-html.ts";

function loadAuditModule(): {
  esc: (v: unknown) => string;
  sanitizeAuditCmd: (cmd: unknown) => string;
  isAuditProbe: (cmd: unknown) => boolean;
  auditSource: (e: Record<string, unknown>) => string;
  auditRow: (e: Record<string, unknown>) => string;
} {
  const escStart = APP_HTML.indexOf("function esc(value)");
  assert.ok(escStart > 0, "esc must be defined in APP_HTML");
  const escEnd = APP_HTML.indexOf("\nfunction ", escStart + 20);
  const escCode = APP_HTML.slice(escStart, escEnd);

  const start = APP_HTML.indexOf("function sanitizeAuditCmd(cmd)");
  assert.ok(start > 0, "sanitizeAuditCmd must be defined in APP_HTML");
  const end = APP_HTML.indexOf("\nfunction updateAuditProbeCount()", start);
  assert.ok(end > start, "updateAuditProbeCount must follow audit block");
  const auditCode = APP_HTML.slice(start, end);

  const fn = new Function(`
    ${escCode}
    ${auditCode}
    return { esc, sanitizeAuditCmd, isAuditProbe, auditSource, auditRow };
  `);
  return fn();
}

test("auditRow includes space between timestamp, badge, and command body to prevent concatenation", () => {
  const { auditRow } = loadAuditModule();
  const ev = {
    type: "exec",
    time: "2026-09-09T19:12:55.000Z",
    source: "user",
    detail: { cmd: "git status", user: "box" },
  };
  const html = auditRow(ev);
  // Ensure the layout places whitespace between closing span tags and next content
  assert.match(
    html,
    /<span class="at">[^<]+<\/span>\s+<span class="badge badge-user">user<\/span>\s+<div class="audit-body">/,
    "timestamp, badge, and body must be separated by whitespace"
  );

  // Strip tags and verify no concatenation like 7:12:55PMgit
  const plainText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  assert.match(plainText, /\buser\s+git status\b/, "plain text copy must have clear spacing");
});

test("sanitizeAuditCmd strips ANSI escape codes and sanitizes control characters", () => {
  const { sanitizeAuditCmd } = loadAuditModule();

  // ANSI color escapes (\x1b[31m ... \x1b[0m)
  const ansiCmd = "\x1b[31mrm -rf /tmp/test\x1b[0m";
  assert.equal(sanitizeAuditCmd(ansiCmd), "rm -rf /tmp/test");

  // Non-printable control char (null byte \x00, bell \x07)
  const ctrlCmd = "echo \x00 test \x07";
  assert.equal(sanitizeAuditCmd(ctrlCmd), "echo \\x00 test \\x07");

  // HTML entities are escaped
  const xssCmd = "cat <file> && echo '\"hello\" & bye'";
  assert.equal(
    sanitizeAuditCmd(xssCmd),
    "cat &lt;file&gt; &amp;&amp; echo '&quot;hello&quot; &amp; bye'"
  );
});

test("isAuditProbe correctly identifies repetitive system supervisor health probes", () => {
  const { isAuditProbe } = loadAuditModule();

  // Common start-display supervisor health checks
  assert.ok(isAuditProbe("tr \\0 \\n"));
  assert.ok(isAuditProbe("tr '\\0' '\\n'"));
  assert.ok(isAuditProbe("tr \"\\0\" \"\\n\""));
  assert.ok(isAuditProbe("grep -Fqx DISPLAY=:1"));
  assert.ok(isAuditProbe("grep -Fqxz DISPLAY=:2 /proc/123/environ"));
  assert.ok(isAuditProbe("pgrep -f -- pcmanfm --desktop"));
  assert.ok(isAuditProbe("pgrep -f xwatchdog"));
  assert.ok(isAuditProbe("pgrep -f autocutsel"));
  assert.ok(isAuditProbe("pgrep -f Xvfb :1"));
  assert.ok(isAuditProbe("xdpyinfo -display :1"));
  assert.ok(isAuditProbe("/usr/local/bin/box-healthcheck"));

  // Normal user / agent commands must not be identified as probes
  assert.ok(!isAuditProbe("git commit -m 'feat: update'"));
  assert.ok(!isAuditProbe("npm test"));
  assert.ok(!isAuditProbe("grep -rn 'DISPLAY' src/"));
  assert.ok(!isAuditProbe("tr '[:lower:]' '[:upper:]'"));
  assert.ok(!isAuditProbe("pgrep my_custom_service"));
  assert.ok(!isAuditProbe("cat /usr/local/bin/box-healthcheck"));
});

test("auditSource classifies human user terminal, agent execution, and system probes", () => {
  const { auditSource } = loadAuditModule();

  // Human user in terminal (pty / pts)
  assert.equal(
    auditSource({
      type: "exec",
      detail: { tty: "/dev/pts/0", cmd: "htop", user: "box" },
    }),
    "user"
  );

  // GUI window focus is user interaction
  assert.equal(
    auditSource({
      type: "window_focus",
      window: "Visual Studio Code",
      detail: {},
    }),
    "user"
  );

  // System supervisor probe
  assert.equal(
    auditSource({
      type: "exec",
      detail: { tty: "none", cmd: "tr \\0 \\n", user: "box" },
    }),
    "system"
  );

  // Daemon / hostd user
  assert.equal(
    auditSource({
      type: "exec",
      detail: { tty: "none", cmd: "node hostd.mjs", user: "hostd" },
    }),
    "system"
  );

  // Agent execution (headless tty=none, normal work command)
  assert.equal(
    auditSource({
      type: "exec",
      detail: { tty: "none", cmd: "pytest tests/", user: "box" },
    }),
    "agent"
  );
});

test("CSS rules include hide-probes rule and audit state elements exist in template", () => {
  assert.match(
    APP_HTML,
    /#auditlist\.hide-probes\s+\.auditrow\.probe\s*\{\s*display:\s*none;\s*\}/,
    "CSS must hide probe rows when .hide-probes is active"
  );
  assert.match(APP_HTML, /id="audithideprobes"[^>]*checked/, "hide probes toggle must be checked by default");
  assert.match(APP_HTML, /class="scroll hide-probes" id="auditlist"/, "auditlist must default to hiding probes");
});

test("pollAudit queries tail=1&limit=200 on initial load to prevent lag", () => {
  assert.match(
    APP_HTML,
    /auditSince === 0\s*\?\s*["']\/api\/xwatchdog\/events\?tail=1&limit=200["']/,
    "pollAudit must request recent tail on initial load when auditSince is 0"
  );
});
