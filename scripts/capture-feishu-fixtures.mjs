/**
 * Captures one real message of each shape from Feishu, sanitised, as a test corpus.
 *
 * Every payload in this repository's channel tests was written from somebody's mental
 * model of the wire, and the wire has been wrong about that repeatedly: the video-chat
 * message's number lives in `meet_number` (not `meeting_no`, which is what a reasonable
 * person writes), a topic reply carries `root_id` while the topic itself carries
 * `thread_id`, and rich text arrives as `post` with a nested array-of-arrays whose
 * absence made the bot look like it ignored messages at random. Each of those cost a
 * production incident and was then pinned by a hand-written literal — one shape at a
 * time, only after it broke.
 *
 * The mature harnesses this was modelled on have no recorded payloads at all (OpenClaw
 * and Hermes both compensate with a live tier run against real credentials, docs/27).
 * We have real credentials on the same machine as the tests, which is exactly why the
 * tests must not see them — so a captured corpus is the cheaper insurance here.
 *
 * **Content is replaced, structure is kept.** The corpus exists to pin field names,
 * nesting and types; the words are somebody's private conversation and are none of a
 * test's business. Ids become stable fixture ids so a diff is readable.
 *
 * Usage: node scripts/capture-feishu-fixtures.mjs   (needs FEISHU_APP_ID/SECRET)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const configPath = join(homedir(), ".agentbox", "config.json");
const env = { ...process.env, ...(JSON.parse(readFileSync(configPath, "utf8")).env ?? {}) };
const appId = env.FEISHU_APP_ID;
const appSecret = env.FEISHU_APP_SECRET;
if (!appId || !appSecret) {
  console.error("Set FEISHU_APP_ID and FEISHU_APP_SECRET (or have them in config.json).");
  process.exit(1);
}

const token = await fetch(
  "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  }
)
  .then(response => response.json())
  .then(body => body.tenant_access_token);

const get = path =>
  fetch(`https://open.feishu.cn/open-apis${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(response => response.json());

/** Stable stand-ins, so the same real id always becomes the same fixture id. */
const aliases = new Map();
const alias = (value, prefix) => {
  if (typeof value !== "string" || value === "") return value;
  if (!aliases.has(value)) aliases.set(value, `${prefix}_fixture${aliases.size + 1}`);
  return aliases.get(value);
};

/**
 * Words out, shape in — and the difference matters more than it looks.
 *
 * A first version scrubbed every string leaf and produced a corpus where `msg_type` was
 * "示例 sample" and the body was an opaque line: sanitised into uselessness, because the
 * enum values and the tag names *are* the shape. So the rule is by field, not by type:
 * discriminators and structural keys survive verbatim, free text and identifiers do not.
 */
const STRUCTURAL_KEYS = new Set([
  "msg_type",
  "sender_type",
  "id_type",
  "tag",
  "deleted",
  "updated",
  "chat_type",
  "type",
  "style",
  "un_escape",
]);

const scrub = (value, key) => {
  if (typeof value === "string") {
    if (STRUCTURAL_KEYS.has(key ?? "")) return value;
    if (/^om_/.test(value)) return alias(value, "om");
    if (/^omt_/.test(value)) return alias(value, "omt");
    if (/^oc_/.test(value)) return alias(value, "oc");
    if (/^ou_/.test(value)) return alias(value, "ou");
    if (/^cli_/.test(value)) return alias(value, "cli");
    if (/^img_/.test(value)) return alias(value, "img");
    if (/^file_/.test(value)) return alias(value, "file");
    if (/^\d{10,}$/.test(value)) return "1788000000000";
    if (value.length === 0) return value;
    // The body's content is a JSON string on this wire. Parsed, scrubbed and
    // re-encoded, because the double encoding is part of the shape and because a
    // corpus whose bodies are opaque strings pins nothing about the bodies.
    if (key === "content" && /^[[{]/.test(value.trim())) {
      try {
        return JSON.stringify(scrub(JSON.parse(value)));
      } catch {
        // Not JSON after all; fall through to the plain-text treatment.
      }
    }
    // Keep the language mix, because a parser that only ever saw ASCII is a parser
    // that has not been tested here.
    return value.length > 20 ? "示例文本 sample text for shape only" : "示例 sample";
  }
  if (Array.isArray(value)) return value.map(item => scrub(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([inner, child]) => [inner, scrub(child, inner)])
    );
  }
  return value;
};

const chats = await get("/im/v1/chats?page_size=10");
const byKind = new Map();
for (const chat of (chats.data?.items ?? []).slice(0, 8)) {
  const history = await get(
    `/im/v1/messages?container_id_type=chat&container_id=${chat.chat_id}` +
      `&sort_type=ByCreateTimeDesc&page_size=40`
  );
  for (const message of history.data?.items ?? []) {
    const threaded = message.thread_id !== undefined ? "threaded" : "top-level";
    const key = `${message.msg_type}:${message.sender?.sender_type ?? "?"}:${threaded}`;
    if (!byKind.has(key)) byKind.set(key, message);
  }
}

const corpus = [...byKind.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([kind, message]) => ({
    kind,
    // The body's content is a JSON *string* on this wire; kept that way, because the
    // double encoding is part of the shape and every parser has to survive it.
    message: scrub(message),
  }));

const out = join(process.cwd(), "src/channels/fixtures/feishu-messages.json");
writeFileSync(
  out,
  `${JSON.stringify(
    {
      $comment:
        "CAPTURED from Feishu and sanitised by scripts/capture-feishu-fixtures.mjs — " +
        "content replaced, structure kept. Re-capture rather than hand-editing.",
      capturedAt: new Date().toISOString().slice(0, 10),
      messages: corpus,
    },
    null,
    2
  )}\n`
);
console.log(`${corpus.length} shapes -> ${out}`);
for (const entry of corpus) console.log(`  ${entry.kind}`);
