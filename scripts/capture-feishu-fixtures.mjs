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
  "message_type",
  "key",
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

// Every chat the bot is in, and up to a few hundred messages of each: the corpus wants one
// message per *shape*, and the rarer shapes (a deleted message, an edited one, a reply that
// carries root_id, a mention, a video-chat invite) only turn up deep in a busy room.
const chats = [];
for (let pageToken; ; ) {
  const page = await get(`/im/v1/chats?page_size=50${pageToken ? `&page_token=${pageToken}` : ""}`);
  chats.push(...(page.data?.items ?? []));
  if (!page.data?.has_more || !page.data?.page_token) break;
  pageToken = page.data.page_token;
}
const byKind = new Map();
/**
 * The shape key (INV-128): message type, who sent it, threaded or not, and the flags that
 * change how a parser must treat it — a reply (root_id), an edit, a deletion, a mention,
 * a direct chat. Two messages with the same key are the same shape; one is kept.
 */
const kindOf = message => {
  const body = typeof message.body?.content === "string" ? message.body.content : "";
  const flags = [
    message.thread_id !== undefined ? "threaded" : "top-level",
    message.root_id !== undefined && message.root_id !== message.message_id ? "reply" : "",
    message.updated === true ? "edited" : "",
    message.deleted === true ? "deleted" : "",
    message.mentions?.length > 0 || /"key":"@_user_/.test(body) ? "mention" : "",
    message.chat_type === "p2p" ? "p2p" : "",
  ].filter(Boolean);
  return `${message.msg_type}:${message.sender?.sender_type ?? "?"}:${flags.join("+")}`;
};
for (const chat of chats) {
  let pageToken;
  for (let pages = 0; pages < 5; pages += 1) {
    const history = await get(
      `/im/v1/messages?container_id_type=chat&container_id=${chat.chat_id}` +
        `&sort_type=ByCreateTimeDesc&page_size=50${pageToken ? `&page_token=${pageToken}` : ""}`
    );
    for (const message of history.data?.items ?? []) {
      const key = kindOf(message);
      if (!byKind.has(key)) byKind.set(key, message);
    }
    if (!history.data?.has_more || !history.data?.page_token) break;
    pageToken = history.data.page_token;
  }
}
const corpus = [...byKind.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([kind, message]) => ({
    kind,
    // Provenance (INV-128): where it came from, how it was changed, what a reader should do with it.
    source: "feishu-api:/im/v1/messages (the operator's own tenant, bot-visible chats); API shape — the live event carries mentions[].id.open_id where this carries mentions[].id as a string",
    sanitised: "ids aliased to *_fixtureN, timestamps fixed, free text replaced; discriminators and structure kept",
    // What the receiver must do with it: our own cards and system notices are not work, a
    // deleted message has no body left to read; everything else becomes an inbound message.
    expect: message.deleted === true || message.msg_type === "system" || message.msg_type === "interactive" ? "ignore" : "normalize",
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
