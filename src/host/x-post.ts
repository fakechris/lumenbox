/**
 * Reading a post on X (Twitter) from the host, as text an agent can actually use.
 *
 * `fetchPage` on an x.com status URL gets the login wall: a `<title>` holding the first
 * line of the post and nothing else. Measured on one day of one agent's reading
 * (2026-09-19): nineteen X links, eighteen of them X *Articles* with 3k–28k characters
 * of body each, and the agent saw forty-three characters of each — a t.co link. Every
 * "fact check" it wrote that day was against text it had never read.
 *
 * So x.com is read through FxTwitter's public API instead, which returns the full
 * article body (as Draft.js blocks), the self-thread, the author, and a tombstone with a
 * reason when a post is gone. The X syndication endpoint is the fallback when FxTwitter
 * cannot be reached — it is durable but truncates long posts and only previews
 * articles, so anything it returns is marked `partial`, never presented as the post.
 *
 * Whatever came back is kept on disk beside a rendering of it, with hashes, because the
 * tool result an agent reads is cut to two thousand characters when the transcript is
 * stored (docs/24) and the evidence for what it cited would otherwise be gone by the
 * time anyone asked.
 *
 * Deliberately not: a logged-in account (bans), the official API (cannot read Articles
 * at all), or a scraper of the site itself.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../config.ts";
import { fetchPage, WebError } from "./web.ts";

/** Where FxTwitter is. Settable so an installation can point at its own FxEmbed. */
export const FXTWITTER_BASE_VARIABLE = "AGENTBOX_FXTWITTER_BASE";
export const X_SYNDICATION_BASE_VARIABLE = "AGENTBOX_X_SYNDICATION_BASE";
const DEFAULT_FXTWITTER_BASE = "https://api.fxtwitter.com";
const DEFAULT_SYNDICATION_BASE = "https://cdn.syndication.twimg.com";

export interface XStatusRef {
  id: string;
  /** The handle in the URL, when it had one; `/i/web/status/` links do not. */
  handle?: string;
  /** The URL as X itself would write it. */
  canonical: string;
}

const X_HOSTS = /^(?:www\.|mobile\.)?(?:x\.com|twitter\.com)$/i;

/** Recognises a link to one post. Anything else on x.com is not something this reads. */
export function xStatusRef(rawUrl: string): XStatusRef | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!X_HOSTS.test(url.hostname)) return undefined;
  const parts = url.pathname.split("/").filter(part => part !== "");
  // /<handle>/status/<id>, /i/web/status/<id>, /i/status/<id>
  const at = parts.indexOf("status");
  if (at === -1) return undefined;
  const id = parts[at + 1];
  if (id === undefined || !/^\d{5,25}$/.test(id)) return undefined;
  const head = parts.slice(0, at);
  const handle = head.length === 1 && head[0] !== "i" ? head[0] : undefined;
  return {
    id,
    ...(handle !== undefined ? { handle } : {}),
    canonical: `https://x.com/${handle ?? "i/web"}/status/${id}`,
  };
}

export type XKind = "tweet" | "note" | "article" | "reply";
export type XCompleteness = "full" | "partial" | "unavailable";
export type XFetcher = "fxtwitter-v2" | "syndication";

export interface XMedia {
  url: string;
  type?: string;
  alt?: string;
}

export interface XThreadPost {
  id: string;
  text: string;
  published?: string;
}

export interface XPost {
  id: string;
  canonical: string;
  kind: XKind;
  title: string;
  author?: { handle: string; name: string };
  /** ISO-8601, when the source said. */
  published?: string;
  fetcher: XFetcher;
  completeness: XCompleteness;
  /** Why, when `completeness` is not `full`. */
  note?: string;
  articleId?: string;
  /** Every post in the self-thread, the post itself included, in order. */
  threadIds: string[];
  /** Expanded, not t.co. */
  links: string[];
  media: XMedia[];
  communityNote?: string;
  replyingTo?: string;
  /** The post's own text, links expanded. */
  text: string;
  /** The article body as markdown, when the post is an article. */
  articleBody?: string;
  quote?: { url?: string; author?: string; text: string };
  /** The rest of the self-thread, the post itself excluded. */
  thread: XThreadPost[];
}

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** "Fri Sep 18 12:15:26 +0000 2026", the format X has used since 2006, to ISO. */
function isoDate(value: unknown, timestamp?: unknown): string | undefined {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp * 1000).toISOString();
  }
  const text = asString(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

// ---------------------------------------------------------------------------------------
// Article bodies: Draft.js blocks to markdown.
// ---------------------------------------------------------------------------------------

interface DraftEntity {
  type?: string;
  data?: Json;
}

/**
 * The entity map arrives as a list of `{key, value}` from FxTwitter and as an object
 * keyed by number from X itself; both are seen in the wild and both are read.
 */
function entityMap(content: Json): Map<string, DraftEntity> {
  const out = new Map<string, DraftEntity>();
  const raw = content.entityMap;
  if (Array.isArray(raw)) {
    raw.forEach((entry, index) => {
      const item = asObject(entry);
      if (item === undefined) return;
      const value = asObject(item.value) ?? item;
      const key = item.key !== undefined ? String(item.key) : String(index);
      out.set(key, { ...(asString(value.type) !== undefined ? { type: asString(value.type) } : {}), ...(asObject(value.data) !== undefined ? { data: asObject(value.data) } : {}) });
    });
  } else {
    const object = asObject(raw) ?? {};
    for (const [key, entry] of Object.entries(object)) {
      const value = asObject(entry) ?? {};
      out.set(key, { ...(asString(value.type) !== undefined ? { type: asString(value.type) } : {}), ...(asObject(value.data) !== undefined ? { data: asObject(value.data) } : {}) });
    }
  }
  return out;
}

/** `media_id` → image URL and alt text, from the article's own media list. */
function articleMedia(article: Json): Map<string, XMedia> {
  const out = new Map<string, XMedia>();
  for (const entry of asArray(article.media_entities)) {
    const item = asObject(entry);
    if (item === undefined) continue;
    const info = asObject(item.media_info) ?? {};
    const id = asString(item.media_id) ?? asString(item.id);
    if (id === undefined) continue;
    const typename = asString(info.__typename) ?? "";
    // A video or gif carries its variants and a preview image; the best variant is the
    // one to name, the preview is what a reader who cannot play it sees.
    const variants = asArray(info.variants)
      .map(asObject)
      .filter((variant): variant is Json => variant !== undefined && asString(variant.url) !== undefined)
      .sort((a, b) => (typeof b.bit_rate === "number" ? b.bit_rate : 0) - (typeof a.bit_rate === "number" ? a.bit_rate : 0));
    const moving = variants[0] !== undefined ? asString(variants[0].url) : undefined;
    const url = moving ?? asString(info.original_img_url) ?? asString(asObject(info.preview_image)?.original_img_url) ?? asString(info.url);
    if (url === undefined) continue;
    const alt = asString(info.alt_text) ?? (typename === "ApiVideo" ? "video" : typename === "ApiGif" ? "gif" : undefined);
    out.set(id, {
      url,
      ...(typename !== "" ? { type: typename } : {}),
      ...(alt !== undefined ? { alt } : {}),
    });
  }
  return out;
}

/** Wraps the ranges of a block's text that carry LINK entities in markdown links. */
function withInlineLinks(text: string, ranges: unknown[], entities: Map<string, DraftEntity>): string {
  const links = ranges
    .map(asObject)
    .filter((range): range is Json => range !== undefined)
    .map(range => ({
      offset: Number(range.offset),
      length: Number(range.length),
      entity: entities.get(String(range.key)),
    }))
    .filter(
      range =>
        Number.isInteger(range.offset) &&
        Number.isInteger(range.length) &&
        range.length > 0 &&
        range.entity?.type === "LINK" &&
        asString(range.entity.data?.url) !== undefined
    )
    .sort((a, b) => a.offset - b.offset);
  if (links.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const link of links) {
    if (link.offset < cursor) continue;
    const label = text.slice(link.offset, link.offset + link.length);
    out += text.slice(cursor, link.offset);
    out += label.trim() === "" ? label : `[${label}](${asString(link.entity!.data!.url)})`;
    cursor = link.offset + link.length;
  }
  return out + text.slice(cursor);
}

/**
 * The article body, block by block.
 *
 * Headings, lists, quotes and code keep their shape; a `MARKDOWN` entity is X's own code
 * block and is passed through as written; a `MEDIA` entity becomes an image whose URL
 * comes from the article's media list; an embedded `TWEET` becomes a link to it; a
 * divider becomes a rule. Inline bold and italic are dropped — the words are what an
 * agent reads, and the ranges would double the size of every fixture.
 */
export function renderArticleBody(article: Json): string {
  const content = asObject(article.content) ?? {};
  const entities = entityMap(content);
  const media = articleMedia(article);
  const out: string[] = [];
  let ordered = 0;
  for (const entry of asArray(content.blocks)) {
    const block = asObject(entry);
    if (block === undefined) continue;
    const type = asString(block.type) ?? "unstyled";
    const text = asString(block.text) ?? "";
    const ranges = asArray(block.entityRanges);
    if (type !== "ordered-list-item") ordered = 0;
    switch (type) {
      case "header-one":
        out.push(`# ${withInlineLinks(text, ranges, entities)}`);
        break;
      case "header-two":
        out.push(`## ${withInlineLinks(text, ranges, entities)}`);
        break;
      case "header-three":
        out.push(`### ${withInlineLinks(text, ranges, entities)}`);
        break;
      case "unordered-list-item":
        out.push(`- ${withInlineLinks(text, ranges, entities)}`);
        break;
      case "ordered-list-item":
        ordered += 1;
        out.push(`${ordered}. ${withInlineLinks(text, ranges, entities)}`);
        break;
      case "blockquote":
        out.push(`> ${withInlineLinks(text, ranges, entities)}`);
        break;
      case "code-block":
        out.push(`\`\`\`\n${text}\n\`\`\``);
        break;
      case "atomic": {
        for (const range of ranges) {
          const key = asObject(range)?.key;
          const entity = key === undefined ? undefined : entities.get(String(key));
          const data = entity?.data ?? {};
          switch (entity?.type) {
            case "MARKDOWN":
              out.push(asString(data.markdown) ?? "");
              break;
            case "DIVIDER":
              out.push("---");
              break;
            case "MEDIA": {
              for (const item of asArray(data.mediaItems)) {
                const id = asString(asObject(item)?.mediaId);
                const found = id === undefined ? undefined : media.get(id);
                out.push(found !== undefined ? `![${found.alt ?? "image"}](${found.url})` : `![image](x-media:${id ?? "?"})`);
              }
              break;
            }
            case "TWEET": {
              const id = asString(data.tweetId);
              out.push(id !== undefined ? `[Embedded post](https://x.com/i/web/status/${id})` : "[Embedded post]");
              break;
            }
            default:
              if (text.trim() !== "") out.push(text);
          }
        }
        break;
      }
      default:
        out.push(withInlineLinks(text, ranges, entities));
    }
  }
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Every non-atomic block's text, joined — what the body must contain, whatever the markup. */
export function articleBlockTexts(article: Json): string[] {
  return asArray(asObject(article.content)?.blocks)
    .map(asObject)
    .filter((block): block is Json => block !== undefined && asString(block.type) !== "atomic")
    .map(block => asString(block.text) ?? "")
    .filter(text => text.trim() !== "");
}

// ---------------------------------------------------------------------------------------
// FxTwitter v2: /2/thread/{id} and /2/status/{id}.
// ---------------------------------------------------------------------------------------

const TOMBSTONE_REASONS = new Set(["deleted", "suspended", "private", "blocked", "unavailable"]);

function unavailable(ref: XStatusRef, fetcher: XFetcher, reason: string, note?: string): XPost {
  return {
    id: ref.id,
    canonical: ref.canonical,
    kind: "tweet",
    title: `Post ${ref.id} (${reason})`,
    fetcher,
    completeness: "unavailable",
    note: note ?? `The post is ${reason}.`,
    threadIds: [],
    links: [],
    media: [],
    text: "",
    thread: [],
  };
}

function statusLinks(status: Json): string[] {
  const links: string[] = [];
  const facets = asArray(asObject(status.raw_text)?.facets);
  for (const entry of facets) {
    const facet = asObject(entry);
    if (facet?.type !== "url") continue;
    const target = asString(facet.replacement) ?? asString(facet.original);
    if (target !== undefined && !links.includes(target)) links.push(target);
  }
  return links;
}

function statusMedia(status: Json): XMedia[] {
  const all = asArray(asObject(status.media)?.all);
  return all
    .map(asObject)
    .filter((item): item is Json => item !== undefined && asString(item.url) !== undefined)
    .map(item => ({
      url: asString(item.url)!,
      ...(asString(item.type) !== undefined ? { type: asString(item.type) } : {}),
      ...(asString(item.altText) !== undefined ? { alt: asString(item.altText) } : {}),
    }));
}

function statusText(status: Json): string {
  return asString(status.text) ?? asString(asObject(status.raw_text)?.text) ?? "";
}

/**
 * Reads FxTwitter's v2 answer for one post.
 *
 * `article` present with no blocks is a real thing FxTwitter does now and then — two of
 * nineteen on the day this was written, both full on the next request — so it is not
 * taken as "the article is empty" but as an answer not yet complete; the caller retries
 * once through `/2/status/` and, failing that, says so.
 */
export function parseFxThread(payload: unknown, ref: XStatusRef): XPost {
  const root = asObject(payload);
  if (root === undefined) return unavailable(ref, "fxtwitter-v2", "unavailable", "FxTwitter answered with something that was not JSON.");
  const code = typeof root.code === "number" ? root.code : undefined;
  const status = asObject(root.status) ?? asObject(root.tweet);
  if (status === undefined) {
    return unavailable(
      ref,
      "fxtwitter-v2",
      code === 404 ? "not-found" : "unavailable",
      code === 404
        ? "No post with that id: deleted, never existed, or on a suspended or private account."
        : `FxTwitter returned code ${code ?? "?"} and no post.`
    );
  }
  if (asString(status.type) === "tombstone") {
    const reason = asString(status.reason);
    return unavailable(
      ref,
      "fxtwitter-v2",
      reason !== undefined && TOMBSTONE_REASONS.has(reason) ? reason : "unavailable",
      asString(status.message)
    );
  }

  const author = asObject(status.author);
  const handle = asString(author?.screen_name);
  const article = asObject(status.article);
  const thread = asArray(root.thread).map(asObject).filter((post): post is Json => post !== undefined);
  const threadIds = thread.map(post => asString(post.id)).filter((id): id is string => id !== undefined);
  if (!threadIds.includes(ref.id)) threadIds.unshift(ref.id);
  const text = statusText(status);
  const replyingTo = asString(status.replying_to) ?? undefined;
  const kind: XKind =
    article !== undefined ? "article" : status.is_note_tweet === true ? "note" : replyingTo !== undefined ? "reply" : "tweet";

  const quote = asObject(status.quote);
  const communityNote = asObject(status.community_note);
  const articleBlocks = article !== undefined ? asArray(asObject(article.content)?.blocks) : [];
  const articleEmpty = article !== undefined && articleBlocks.length === 0;

  return {
    id: ref.id,
    canonical: asString(status.url) ?? ref.canonical,
    kind,
    title:
      asString(article?.title) ??
      `${handle !== undefined ? `@${handle}` : "Post"}: ${text.replace(/\s+/g, " ").slice(0, 60)}`,
    ...(handle !== undefined ? { author: { handle, name: asString(author?.name) ?? handle } } : {}),
    ...(isoDate(status.created_at, status.created_timestamp) !== undefined
      ? { published: isoDate(status.created_at, status.created_timestamp) }
      : {}),
    fetcher: "fxtwitter-v2",
    completeness: articleEmpty ? "partial" : "full",
    ...(articleEmpty ? { note: "FxTwitter returned the article without its body." } : {}),
    ...(article !== undefined && asString(article.id) !== undefined ? { articleId: asString(article.id) } : {}),
    threadIds,
    links: statusLinks(status),
    media: statusMedia(status),
    ...(asString(communityNote?.text) !== undefined ? { communityNote: asString(communityNote?.text) } : {}),
    ...(replyingTo !== undefined ? { replyingTo } : {}),
    text,
    ...(article !== undefined && !articleEmpty ? { articleBody: renderArticleBody(article) } : {}),
    ...(quote !== undefined
      ? {
          quote: {
            ...(asString(quote.url) !== undefined ? { url: asString(quote.url) } : {}),
            ...(asString(asObject(quote.author)?.screen_name) !== undefined
              ? { author: asString(asObject(quote.author)?.screen_name) }
              : {}),
            text: statusText(quote),
          },
        }
      : {}),
    thread: thread
      .filter(post => asString(post.id) !== ref.id)
      .map(post => ({
        id: asString(post.id) ?? "",
        text: statusText(post),
        ...(isoDate(post.created_at, post.created_timestamp) !== undefined
          ? { published: isoDate(post.created_at, post.created_timestamp) }
          : {}),
      })),
  };
}

// ---------------------------------------------------------------------------------------
// The syndication endpoint: the fallback, always partial.
// ---------------------------------------------------------------------------------------

/**
 * The token X's own embed code derives from the id. Not validated server-side at the
 * time of writing, but sent as the embed sends it so a change on their side is not a
 * change on ours.
 */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

export function parseSyndication(payload: unknown, ref: XStatusRef): XPost {
  const root = asObject(payload);
  if (root === undefined || asString(root.id_str) === undefined) {
    return unavailable(ref, "syndication", "unavailable", "The syndication endpoint did not return the post.");
  }
  const user = asObject(root.user);
  const handle = asString(user?.screen_name);
  const article = asObject(root.article);
  const text = asString(root.text) ?? "";
  const links: string[] = [];
  for (const entry of asArray(asObject(root.entities)?.urls)) {
    const expanded = asString(asObject(entry)?.expanded_url);
    if (expanded !== undefined && !links.includes(expanded)) links.push(expanded);
  }
  const media = asArray(root.mediaDetails)
    .map(asObject)
    .filter((item): item is Json => item !== undefined && asString(item.media_url_https) !== undefined)
    .map(item => ({
      url: asString(item.media_url_https)!,
      ...(asString(item.type) !== undefined ? { type: asString(item.type) } : {}),
      ...(asString(item.ext_alt_text) !== undefined ? { alt: asString(item.ext_alt_text) } : {}),
    }));
  const quoted = asObject(root.quoted_tweet);
  const parent = asObject(root.parent);
  const isNote = asObject(root.note_tweet) !== undefined;
  const kind: XKind = article !== undefined ? "article" : isNote ? "note" : parent !== undefined ? "reply" : "tweet";
  const why =
    article !== undefined
      ? "The syndication endpoint previews an article; the body is not included."
      : isNote
        ? "The syndication endpoint truncates long posts; the full text is not included."
        : "Read through the syndication endpoint, which does not carry threads.";
  return {
    id: ref.id,
    canonical: ref.canonical,
    kind,
    title:
      asString(article?.title) ??
      `${handle !== undefined ? `@${handle}` : "Post"}: ${text.replace(/\s+/g, " ").slice(0, 60)}`,
    ...(handle !== undefined ? { author: { handle, name: asString(user?.name) ?? handle } } : {}),
    ...(isoDate(root.created_at) !== undefined ? { published: isoDate(root.created_at) } : {}),
    fetcher: "syndication",
    completeness: "partial",
    note: why,
    ...(asString(article?.rest_id) !== undefined ? { articleId: asString(article?.rest_id) } : {}),
    threadIds: [ref.id],
    links,
    media,
    ...(asString(parent?.id_str) !== undefined ? { replyingTo: asString(parent?.id_str) } : {}),
    text:
      article !== undefined && asString(article.preview_text) !== undefined
        ? `${text}\n\n${asString(article.preview_text)}`
        : text,
    ...(quoted !== undefined
      ? {
          quote: {
            ...(asString(asObject(quoted.user)?.screen_name) !== undefined
              ? { author: asString(asObject(quoted.user)?.screen_name) }
              : {}),
            text: asString(quoted.text) ?? "",
          },
        }
      : {}),
    thread: [],
  };
}

// ---------------------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------------------

export interface RenderOptions {
  fetchedAt: string;
  /** sha256 of the raw answer the post was read from, when it was kept. */
  rawSha256?: string;
  /** Where the raw answer and this rendering were kept. */
  keptIn?: string;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: readonly string[]): string {
  return values.length === 0 ? "[]" : `[${values.map(yamlString).join(", ")}]`;
}

/** The body: what the frontmatter's `body_sha256` is over. */
export function renderXBody(post: XPost): string {
  const parts: string[] = [];
  if (post.completeness === "unavailable") {
    parts.push(`_${post.note ?? "The post is unavailable."}_`);
    return parts.join("\n\n");
  }
  if (post.kind === "article" && post.articleBody !== undefined) {
    parts.push(`# ${post.title}`);
    parts.push(post.articleBody);
  } else {
    parts.push(post.text);
  }
  if (post.quote !== undefined) {
    const who = post.quote.author !== undefined ? `@${post.quote.author}` : "quoted post";
    const where = post.quote.url !== undefined ? ` (${post.quote.url})` : "";
    parts.push(`> **${who}**${where}\n> ${post.quote.text.split("\n").join("\n> ")}`);
  }
  if (post.thread.length > 0) {
    parts.push("## Thread");
    post.thread.forEach((entry, index) => {
      parts.push(`${index + 2}. ${entry.text}`);
    });
  }
  if (post.communityNote !== undefined) {
    parts.push(`## Community note\n\n${post.communityNote}`);
  }
  if (post.media.length > 0 && post.kind !== "article") {
    parts.push(post.media.map(item => `![${item.alt ?? item.type ?? "media"}](${item.url})`).join("\n"));
  }
  return parts.join("\n\n").trim();
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Markdown with frontmatter: the shape a capture takes on the other side of a bridge. */
export function renderXPost(post: XPost, options: RenderOptions): string {
  const body = renderXBody(post);
  const lines = [
    "---",
    `source: ${yamlString(post.canonical)}`,
    `canonical: ${yamlString(post.canonical)}`,
    `kind: ${post.kind}`,
    `title: ${yamlString(post.title)}`,
    ...(post.author !== undefined
      ? [`author: ${yamlString(post.author.name)}`, `author_handle: ${yamlString(post.author.handle)}`]
      : []),
    ...(post.published !== undefined ? [`published: ${post.published}`] : []),
    `fetched_at: ${options.fetchedAt}`,
    `fetcher: ${post.fetcher}`,
    `completeness: ${post.completeness}`,
    ...(post.note !== undefined ? [`note: ${yamlString(post.note)}`] : []),
    ...(post.articleId !== undefined ? [`article_id: ${yamlString(post.articleId)}`] : []),
    `thread_ids: ${yamlList(post.threadIds)}`,
    `links: ${yamlList(post.links)}`,
    ...(post.media.length > 0
      ? [
          "media:",
          ...post.media.map(
            item => `  - url: ${yamlString(item.url)}${item.alt !== undefined ? `\n    alt: ${yamlString(item.alt)}` : ""}`
          ),
        ]
      : ["media: []"]),
    ...(post.replyingTo !== undefined ? [`replying_to: ${yamlString(post.replyingTo)}`] : []),
    ...(post.communityNote !== undefined ? ["community_note: true"] : []),
    ...(options.rawSha256 !== undefined ? [`raw_sha256: ${options.rawSha256}`] : []),
    `body_sha256: ${sha256(body)}`,
    ...(options.keptIn !== undefined ? [`kept_in: ${yamlString(options.keptIn)}`] : []),
    "---",
    "",
  ];
  return `${lines.join("\n")}${body}\n`;
}

// ---------------------------------------------------------------------------------------
// Fetching.
// ---------------------------------------------------------------------------------------

export interface XFetchDeps {
  /** The transport, as `fetchPage` takes it. Tests replace it; nothing else does. */
  open?: Parameters<typeof fetchPage>[1];
  fxtwitterBase?: string;
  syndicationBase?: string;
  now?: () => Date;
  /**
   * Where to keep what came back. `null` keeps nothing; absent means
   * `~/.agentbox/fetched/x/`.
   */
  keepUnder?: string | null;
}

export interface XFetchResult {
  post: XPost;
  markdown: string;
  /**
   * Where the raw answer and the rendering were written, when they were, and a digest of
   * the rendering — so the pointer in the transcript can describe its own target after the
   * target is pruned (fetched.ts, INV-659).
   */
  kept?: { dir: string; raw: string; markdown: string; sha256: string; at: string };
}

async function fetchJson(url: string, open: XFetchDeps["open"]): Promise<{ raw: string; parsed: unknown }> {
  // The whole answer: an API reply is parsed here, not read by a model, and a thread
  // with its authors runs well past the page limit. A 404 is kept too — FxTwitter says
  // "no such post" that way, with a JSON body, and that is an answer about the post.
  const page = await fetchPage(url, open, { maxText: Number.MAX_SAFE_INTEGER, passStatuses: [404] });
  try {
    return { raw: page.text, parsed: JSON.parse(page.text) };
  } catch {
    throw new WebError(`${url} did not answer with JSON.`);
  }
}

/**
 * Reads one post: FxTwitter first, the syndication endpoint when FxTwitter cannot be
 * reached, and a plain refusal when neither can. A tombstone from FxTwitter is an
 * answer — the post is gone — and is not second-guessed through the fallback.
 */
export async function fetchXPost(rawUrl: string, deps: XFetchDeps = {}): Promise<XFetchResult> {
  const ref = xStatusRef(rawUrl);
  if (ref === undefined) throw new WebError(`${rawUrl} is not a link to a post on X.`);
  const fxBase = (deps.fxtwitterBase ?? process.env[FXTWITTER_BASE_VARIABLE] ?? DEFAULT_FXTWITTER_BASE).replace(/\/+$/, "");
  const syndBase = (deps.syndicationBase ?? process.env[X_SYNDICATION_BASE_VARIABLE] ?? DEFAULT_SYNDICATION_BASE).replace(/\/+$/, "");
  const fetchedAt = (deps.now ?? (() => new Date()))().toISOString();

  let post: XPost | undefined;
  let raw: string | undefined;
  let rawName = "fxtwitter-v2.json";
  const failures: string[] = [];
  try {
    const first = await fetchJson(`${fxBase}/2/thread/${ref.id}`, deps.open);
    post = parseFxThread(first.parsed, ref);
    raw = first.raw;
    if (post.completeness === "partial" && post.kind === "article") {
      // The empty-body answer. One more ask, through the other route, before giving up on it.
      try {
        const second = await fetchJson(`${fxBase}/2/status/${ref.id}`, deps.open);
        const again = parseFxThread(second.parsed, ref);
        if (again.completeness === "full") {
          // The thread came from the first answer and is kept; only the body was missing.
          post = { ...again, threadIds: post.threadIds, thread: post.thread };
          raw = second.raw;
        }
      } catch (error) {
        failures.push(`fxtwitter /2/status: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error) {
    failures.push(`fxtwitter: ${error instanceof Error ? error.message : error}`);
  }

  if (post === undefined) {
    try {
      const fallback = await fetchJson(
        `${syndBase}/tweet-result?id=${ref.id}&token=${syndicationToken(ref.id)}`,
        deps.open
      );
      post = parseSyndication(fallback.parsed, ref);
      raw = fallback.raw;
      rawName = "syndication.json";
      post = { ...post, note: `${post.note ?? ""} FxTwitter could not be reached: ${failures.join("; ")}`.trim() };
    } catch (error) {
      failures.push(`syndication: ${error instanceof Error ? error.message : error}`);
      throw new WebError(
        `Could not read ${ref.canonical} from either source.\n${failures.join("\n")}\n` +
          "Open it with browser_open if it must be read now; the box's browser may get through."
      );
    }
  }

  const keepUnder = deps.keepUnder === undefined ? join(agentboxHome(), "fetched", "x") : deps.keepUnder;
  const rawSha = raw !== undefined ? sha256(raw) : undefined;
  if (keepUnder === null || raw === undefined) {
    return { post, markdown: renderXPost(post, { fetchedAt, ...(rawSha !== undefined ? { rawSha256: rawSha } : {}) }) };
  }
  const dir = join(keepUnder, ref.id);
  mkdirSync(dir, { recursive: true });
  const rawPath = join(dir, rawName);
  const markdownPath = join(dir, "post.md");
  const markdown = renderXPost(post, { fetchedAt, rawSha256: rawSha, keptIn: dir });
  writeFileSync(rawPath, raw, "utf8");
  writeFileSync(markdownPath, markdown, "utf8");
  return {
    post,
    markdown,
    kept: { dir, raw: rawPath, markdown: markdownPath, sha256: sha256(markdown), at: fetchedAt },
  };
}
