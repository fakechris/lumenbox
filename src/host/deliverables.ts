/**
 * Whether a file an agent is about to hand a person can be opened as what its name says
 * (INV-692).
 *
 * The outbox used to be pushed on size and filename alone. A `.docx` that is markdown with a
 * new extension, a zip cut off mid-write, a PDF with no trailer, JSON that does not parse —
 * all went out, and the person found out by opening them. "It was generated" and "it can be
 * used" are different claims; this checks the second one, mechanically, on the bytes.
 *
 * Two kinds of finding, because they deserve different treatment:
 *
 * - **broken** — the file cannot be opened as its extension says. Delivery holds these back:
 *   sending a file that will not open is worse than saying it is not ready.
 * - **suspect** — the file opens, but something in it looks unfinished: a `{{placeholder}}`,
 *   lorem ipsum, a "[插入…]" slot, a CSV whose rows disagree on width. The agent is told
 *   before its turn ends; delivery never blocks on these, because a TODO list or a template
 *   can be exactly what was asked for.
 *
 * Unknown extensions pass. A check we cannot make is not a reason to hold somebody's file.
 * Pure Node, no dependencies, and bounded: the input is capped by the caller's 25MB outbox
 * rule, and every inflated part is capped here.
 */
import { inflateRawSync } from "node:zlib";
import type { BoxClient } from "../box/client.ts";

export type DeliverableSeverity = "broken" | "suspect";

export interface DeliverableProblem {
  severity: DeliverableSeverity;
  /** One line, in English, naming what is wrong and where. */
  detail: string;
}

/** Past this, a file is not inspected at all (and so passes): checking is not worth stalling a delivery. */
export const CHECK_LIMIT_BYTES = 25 * 1024 * 1024;
/** One zip part is never inflated past this. A 1MB docx that inflates to 1GB is a zip bomb, not a report. */
const INFLATE_LIMIT_BYTES = 32 * 1024 * 1024;
/** How much text is scanned for placeholders. The first stretch of a document is where a template shows. */
const SCAN_LIMIT_CHARS = 2_000_000;

/**
 * What in a finished document reads as an unfilled slot.
 *
 * Kept narrow on purpose. A bare "TODO" is not here: a task list is a legitimate deliverable
 * and would be flagged in every line. What is here only appears when a template was not
 * filled in.
 */
const PLACEHOLDER_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\{\{\s*[\p{L}\p{N}_.-]{1,40}\s*\}\}/u, label: "an unfilled {{placeholder}}" },
  { pattern: /lorem ipsum/i, label: "lorem ipsum filler" },
  { pattern: /[[【](?:在此|此处)?(?:插入|填写|填入|待补充|待填写)[^\]】\n]{0,40}[\]】]/u, label: "an unfilled [插入…] slot" },
  { pattern: /\[(?:insert|your|add) [^\]\n]{1,40}\]/i, label: "an unfilled [insert …] slot" },
  { pattern: /\[(?:TODO|TBD|PLACEHOLDER)[^\]\n]{0,40}\]/, label: "a [TODO]/[TBD] marker" },
];

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "html", "htm", "csv", "tsv"]);

/** The OOXML part each Office format cannot open without. */
const OOXML_MAIN_PART: Record<string, string> = {
  docx: "word/document.xml",
  xlsx: "xl/workbook.xml",
  pptx: "ppt/presentation.xml",
};

/** The parts whose text a person reads, per Office format, for the placeholder scan. */
const OOXML_TEXT_PARTS: Record<string, (name: string) => boolean> = {
  docx: name => name === "word/document.xml",
  xlsx: name => name === "xl/sharedStrings.xml",
  pptx: name => /^ppt\/slides\/slide\d+\.xml$/.test(name),
};

/**
 * Checks one file. Returns every problem found; an empty list means it may go.
 *
 * `name` is only used for its extension and for the wording, never opened.
 */
export function checkDeliverable(name: string, bytes: Buffer): DeliverableProblem[] {
  if (bytes.length > CHECK_LIMIT_BYTES) return [];
  const extension = extensionOf(name);
  const problems: DeliverableProblem[] = [];
  const broken = (detail: string) => problems.push({ severity: "broken", detail });

  const known = extension in OOXML_MAIN_PART || extension in MAGIC || extension === "pdf" ||
    extension === "json" || TEXT_EXTENSIONS.has(extension);
  if (!known) return [];
  if (bytes.length === 0) {
    broken("the file is empty");
    return problems;
  }

  if (extension === "pdf") {
    const head = bytes.subarray(0, 1024).toString("latin1");
    const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1");
    if (!head.includes("%PDF-")) broken(`it is not a PDF (${sniff(bytes)})`);
    else if (!tail.includes("%%EOF")) broken("the PDF has no end-of-file marker; it was cut off or never finished writing");
    return problems;
  }

  const magic = MAGIC[extension];
  if (magic !== undefined && !magic.test(bytes)) {
    // An image that is a different image format opens everywhere a person would look at it
    // (found on real files: JPEGs saved as .png). Worth a word to the agent, not a held file.
    const otherImage = IMAGE_EXTENSIONS.has(extension) &&
      [...IMAGE_EXTENSIONS].some(other => MAGIC[other]!.test(bytes));
    if (otherImage) problems.push({ severity: "suspect", detail: `it is named .${extension} but ${sniff(bytes)}` });
    else broken(`it is not a ${magic.label} (${sniff(bytes)})`);
    return problems;
  }

  const main = OOXML_MAIN_PART[extension];
  if (main !== undefined) {
    const zip = readZip(bytes);
    if (typeof zip === "string") {
      broken(zip);
      return problems;
    }
    // A zip64 archive or one we cannot index: nothing further can be said, and nothing is.
    if (zip === undefined) return problems;
    const names = new Set(zip.map(entry => entry.name));
    if (!names.has("[Content_Types].xml")) broken("the Office package has no [Content_Types].xml, so Office will refuse it");
    if (!names.has(main)) broken(`the Office package has no ${main}; it is not a valid .${extension}`);
    if (problems.length > 0) return problems;
    const wanted = OOXML_TEXT_PARTS[extension]!;
    let text = "";
    for (const entry of zip) {
      if (!wanted(entry.name) || text.length >= SCAN_LIMIT_CHARS) continue;
      const part = inflate(bytes, entry);
      if (typeof part === "string") {
        broken(`${entry.name} cannot be read (${part})`);
        return problems;
      }
      text += `${xmlText(part.toString("utf8"))}\n`;
    }
    problems.push(...placeholders(text));
    return problems;
  }

  if (magic !== undefined) return problems;

  const text = decodeText(bytes);
  if (extension === "json") {
    try {
      JSON.parse(text);
    } catch (error) {
      broken(`the JSON does not parse (${error instanceof Error ? error.message : String(error)})`);
    }
    return problems;
  }
  if (extension === "csv" || extension === "tsv") {
    const ragged = raggedRows(text, extension === "tsv" ? "\t" : ",");
    if (ragged !== undefined) problems.push({ severity: "suspect", detail: ragged });
  }
  problems.push(...placeholders(extension === "html" || extension === "htm" ? xmlText(text) : text));
  return problems;
}

/** Whether any finding would stop a delivery. */
export function isBroken(problems: readonly DeliverableProblem[]): boolean {
  return problems.some(problem => problem.severity === "broken");
}

/**
 * What the agent is told before its turn ends, or undefined when every file is fine.
 *
 * Written as a fact about the files and what to do next, never as a verdict on the work: a
 * placeholder may be intended, and the wording leaves room for the agent to say so.
 */
export function deliverableReport(
  findings: readonly { name: string; problems: readonly DeliverableProblem[] }[],
  chinese: boolean
): string | undefined {
  const flagged = findings.filter(finding => finding.problems.length > 0);
  if (flagged.length === 0) return undefined;
  const lines = flagged.flatMap(finding =>
    finding.problems.map(problem => `- ${finding.name}: ${problem.detail}${problem.severity === "broken" ? " [will not be sent]" : ""}`)
  );
  const anyBroken = flagged.some(finding => isBroken(finding.problems));
  if (chinese) {
    return (
      "[harness] 交付前检查了 outbox 里的文件，发现：\n" +
      `${lines.join("\n")}\n\n` +
      (anyBroken
        ? "标着 [will not be sent] 的文件打不开，不会发给对方。重新生成它，用真正的格式写（例如 .docx 要用能生成 Word 文件的库，而不是把 markdown 改个扩展名），然后再检查一遍。"
        : "文件能打开，但看起来有没填完的地方。") +
      "如果某一处是对方要的（例如他要的就是一个模板），在回复里说一句即可；否则改好再交。同一个问题修了三次还不行，就如实告诉对方卡在哪里。"
    );
  }
  return (
    "[harness] The files in the outbox were checked before delivery:\n" +
    `${lines.join("\n")}\n\n` +
    (anyBroken
      ? "Files marked [will not be sent] cannot be opened and will not reach the person. Regenerate them in the real format (a .docx needs a library that writes Word files, not markdown with a new extension), then check again. "
      : "The files open, but something in them looks unfinished. ") +
    "If a flagged spot is what the person asked for (a template, say), say so in your reply; otherwise fix it before you finish. If the same problem survives three attempts, tell the person plainly where it is stuck."
  );
}

/** How many times per turn the delivery gate may send the model back. Like the guards: bounded, never a loop. */
export const MAX_DELIVERABLE_NUDGES = 2;

/**
 * Every file waiting in a chat's outbox, checked. An outbox that does not exist, or a file
 * that cannot be read, is simply not reported: this is advice before delivery, and delivery
 * says for itself what it could not send.
 */
export async function outboxFindings(
  box: Pick<BoxClient, "listDir" | "downloadFile">,
  chatRoot: string
): Promise<{ name: string; problems: DeliverableProblem[] }[]> {
  const outbox = `${chatRoot}/outbox`;
  let entries: { name: string; type: string; size: number }[];
  try {
    entries = (await box.listDir(outbox)).entries;
  } catch {
    return [];
  }
  const findings: { name: string; problems: DeliverableProblem[] }[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || entry.size > CHECK_LIMIT_BYTES) continue;
    try {
      const file = await box.downloadFile(`${outbox}/${entry.name}`);
      if (typeof file?.base64 !== "string") continue;
      findings.push({ name: entry.name, problems: checkDeliverable(entry.name, Buffer.from(file.base64, "base64")) });
    } catch {
      // Unreadable now is not evidence of a bad file.
    }
  }
  return findings;
}

// ── the checks ─────────────────────────────────────────────────────────────────────────────

const MAGIC: Record<string, { label: string; test: (bytes: Buffer) => boolean }> = {
  png: { label: "PNG image", test: bytes => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { label: "JPEG image", test: bytes => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  jpeg: { label: "JPEG image", test: bytes => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  gif: { label: "GIF image", test: bytes => bytes.subarray(0, 6).toString("latin1").match(/^GIF8[79]a$/) !== null },
  webp: {
    label: "WebP image",
    test: bytes => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
  },
  zip: { label: "zip archive", test: bytes => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) },
  docx: { label: "Word document", test: bytes => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) },
  xlsx: { label: "Excel workbook", test: bytes => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) },
  pptx: { label: "PowerPoint deck", test: bytes => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) },
};

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function startsWith(bytes: Buffer, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

/** What the bytes look like instead, so the agent knows which mistake it made. */
function sniff(bytes: Buffer): string {
  for (const [, magic] of Object.entries(MAGIC)) {
    if (magic.test(bytes)) return `the bytes are a ${magic.label}`;
  }
  if (bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")) return "the bytes are a PDF";
  const head = decodeText(bytes.subarray(0, 512));
  // Control characters other than whitespace mean binary we do not recognise.
  if ([...head].some(char => { const code = char.charCodeAt(0); return code <= 0x08 || (code >= 0x0e && code <= 0x1f); })) {
    return "the bytes are binary of an unknown kind";
  }
  if (/^\s*</.test(head)) return "the bytes are HTML or XML text";
  if (/^\s*[{[]/.test(head)) return "the bytes are JSON-like text";
  if (/^\s*#{1,6}\s|\n\s*[-*]\s/.test(head)) return "the bytes are markdown text";
  return "the bytes are plain text";
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function decodeText(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** An XML or HTML part as the words a reader sees: tags dropped, the common entities decoded. */
function xmlText(xml: string): string {
  return xml
    .slice(0, SCAN_LIMIT_CHARS)
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function placeholders(text: string): DeliverableProblem[] {
  const scanned = text.slice(0, SCAN_LIMIT_CHARS);
  const found: DeliverableProblem[] = [];
  for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
    const match = pattern.exec(scanned);
    if (match !== null) found.push({ severity: "suspect", detail: `it still contains ${label}: "${match[0].slice(0, 60)}"` });
  }
  return found;
}

/**
 * The first row whose field count disagrees with the header, or undefined.
 *
 * A real RFC 4180 reading — quoted fields may hold separators and newlines — because a naive
 * split would call every CSV with an address column ragged.
 */
function raggedRows(text: string, separator: string): string | undefined {
  let fields = 1;
  let quoted = false;
  let row = 1;
  let width: number | undefined;
  let rowHasContent = false;
  for (let index = 0; index < text.length && index < SCAN_LIMIT_CHARS; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') index++;
        else quoted = false;
      }
      continue;
    }
    if (char === '"') { quoted = true; rowHasContent = true; }
    else if (char === separator) { fields++; rowHasContent = true; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      if (rowHasContent) {
        if (width === undefined) width = fields;
        else if (fields !== width) return `row ${row} has ${fields} fields where the header has ${width}`;
        row++;
      }
      fields = 1;
      rowHasContent = false;
    } else rowHasContent = true;
  }
  if (rowHasContent && width !== undefined && fields !== width) return `row ${row} has ${fields} fields where the header has ${width}`;
  return undefined;
}

// ── a zip reader, as far as checking needs ─────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/**
 * The archive's entries from its central directory; a sentence when the archive is broken;
 * undefined when it is a form this reader does not handle (zip64), which is not the same as
 * broken and is not reported as such.
 */
function readZip(bytes: Buffer): ZipEntry[] | string | undefined {
  const floor = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let index = bytes.length - 22; index >= floor; index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end === -1) return "the zip has no end-of-archive record; it was cut off or never finished writing";
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const offset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) return undefined;
  if (offset + size > end) return "the zip's directory points past the end of the file; it is truncated";
  const entries: ZipEntry[] = [];
  let cursor = offset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) return "the zip's directory is corrupt";
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    entries.push({ name, method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's bytes, or a sentence saying why they cannot be had. */
function inflate(bytes: Buffer, entry: ZipEntry): Buffer | string {
  const header = entry.localOffset;
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== 0x04034b50) return "its local header is missing";
  const start = header + 30 + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (data.length < entry.compressedSize) return "its data is cut off";
  if (entry.method === 0) return data;
  if (entry.method !== 8) return `compression method ${entry.method} is not one Office writes`;
  try {
    return inflateRawSync(data, { maxOutputLength: INFLATE_LIMIT_BYTES });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
