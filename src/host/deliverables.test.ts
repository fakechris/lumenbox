import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import { checkDeliverable, deliverableReport, isBroken, CHECK_LIMIT_BYTES } from "./deliverables.ts";

/** A real zip, deflated, the way Office writes one — so the reader is tested on the format rather than on itself. */
function zip(parts: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const raw = Buffer.from(content, "utf8");
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
const docx = (body: string) =>
  zip({ "[Content_Types].xml": TYPES, "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>` });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const text = (value: string) => Buffer.from(value, "utf8");

test("a well-formed docx, xlsx and pptx pass", () => {
  assert.deepEqual(checkDeliverable("report.docx", docx("季度收入增长 12%")), []);
  assert.deepEqual(
    checkDeliverable("sheet.xlsx", zip({ "[Content_Types].xml": TYPES, "xl/workbook.xml": "<workbook/>", "xl/sharedStrings.xml": "<sst><si><t>收入</t></si></sst>" })),
    []
  );
  assert.deepEqual(
    checkDeliverable("deck.pptx", zip({ "[Content_Types].xml": TYPES, "ppt/presentation.xml": "<p/>", "ppt/slides/slide1.xml": "<p:sld><a:t>Q3</a:t></p:sld>" })),
    []
  );
});

test("markdown saved as .docx is broken, and says it is markdown", () => {
  const problems = checkDeliverable("report.docx", text("# 季度报告\n\n- 收入增长\n- 成本下降\n"));
  assert.ok(isBroken(problems));
  assert.match(problems[0]!.detail, /not a Word document.*markdown/);
});

test("a truncated docx is broken", () => {
  const whole = docx("正文");
  const problems = checkDeliverable("report.docx", whole.subarray(0, whole.length - 30));
  assert.ok(isBroken(problems));
  assert.match(problems[0]!.detail, /cut off|truncated|corrupt/);
});

test("an Office package missing its main part is broken", () => {
  const problems = checkDeliverable("sheet.xlsx", zip({ "[Content_Types].xml": TYPES, "xl/styles.xml": "<styles/>" }));
  assert.ok(isBroken(problems));
  assert.match(problems.map(problem => problem.detail).join(" "), /xl\/workbook\.xml/);
  assert.ok(isBroken(checkDeliverable("deck.pptx", zip({ "ppt/presentation.xml": "<p/>" }))), "no [Content_Types].xml");
});

test("an image that is not an image is broken; one that is another image format is only suspect", () => {
  const notAnImage = checkDeliverable("chart.png", text("<svg xmlns='http://www.w3.org/2000/svg'/>"));
  assert.ok(isBroken(notAnImage));
  assert.match(notAnImage[0]!.detail, /not a PNG image.*HTML or XML/);
  // Found on real files: JPEGs saved as .png. Every viewer opens them; holding one would be wrong.
  const jpegAsPng = checkDeliverable("chart.png", JPEG);
  assert.equal(isBroken(jpegAsPng), false);
  assert.match(jpegAsPng[0]!.detail, /named \.png but the bytes are a JPEG image/);
  assert.deepEqual(checkDeliverable("chart.png", PNG), []);
  assert.deepEqual(checkDeliverable("photo.JPG", JPEG), [], "extensions are case-insensitive");
});

test("a PDF needs its header and its end-of-file marker", () => {
  assert.deepEqual(checkDeliverable("a.pdf", text("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n")), []);
  assert.match(checkDeliverable("a.pdf", text("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"))[0]!.detail, /end-of-file/);
  assert.match(checkDeliverable("a.pdf", text("<html>not a pdf</html>"))[0]!.detail, /not a PDF.*HTML/);
});

test("JSON that does not parse is broken", () => {
  assert.deepEqual(checkDeliverable("data.json", text('{"a": 1}')), []);
  assert.deepEqual(checkDeliverable("data.json", text('﻿{"a": 1}')), [], "a BOM is not a syntax error");
  assert.ok(isBroken(checkDeliverable("data.json", text('{"a": 1,}'))));
});

test("placeholders are suspect, never broken", () => {
  const md = checkDeliverable("letter.md", text("尊敬的 {{name}}：\n\n感谢您的来信。"));
  assert.equal(md.length, 1);
  assert.equal(md[0]!.severity, "suspect");
  assert.match(md[0]!.detail, /\{\{name\}\}/);
  assert.equal(checkDeliverable("report.docx", docx("结论：[插入结论]"))[0]!.severity, "suspect");
  assert.equal(checkDeliverable("page.html", text("<p>Lorem ipsum dolor sit amet</p>"))[0]!.severity, "suspect");
  assert.equal(checkDeliverable("memo.txt", text("Dear [Your name],"))[0]!.severity, "suspect");
});

test("a task list is not a placeholder", () => {
  assert.deepEqual(checkDeliverable("todo.md", text("# TODO\n\n- TODO: 订机票\n- TBD 酒店\n")), []);
});

test("a ragged CSV is suspect, and quoted separators do not count", () => {
  assert.deepEqual(checkDeliverable("a.csv", text('name,address\n张三,"北京市, 海淀区"\n李四,"上海\n浦东"\n')), []);
  const ragged = checkDeliverable("a.csv", text("name,city\n张三,北京\n李四,上海,多一列\n"));
  assert.equal(ragged[0]!.severity, "suspect");
  assert.match(ragged[0]!.detail, /row 3 has 3 fields where the header has 2/);
});

test("unknown types, empty known types, and oversized files", () => {
  assert.deepEqual(checkDeliverable("model.bin", text("anything")), [], "an extension we cannot check passes");
  assert.deepEqual(checkDeliverable("README", text("{{x}}")), [], "no extension passes");
  assert.match(checkDeliverable("empty.pdf", Buffer.alloc(0))[0]!.detail, /empty/);
  assert.deepEqual(checkDeliverable("huge.docx", Buffer.alloc(CHECK_LIMIT_BYTES + 1)), [], "past the limit it is not inspected, so it is not blocked");
});

test("the report names each file, marks what will not be sent, and is silent when all is well", () => {
  assert.equal(deliverableReport([{ name: "a.pdf", problems: [] }], false), undefined);
  const report = deliverableReport(
    [
      { name: "report.docx", problems: checkDeliverable("report.docx", text("# heading\n")) },
      { name: "letter.md", problems: checkDeliverable("letter.md", text("Hi {{name}}")) },
    ],
    true
  )!;
  assert.match(report, /report\.docx: .*\[will not be sent\]/);
  assert.match(report, /letter\.md: .*\{\{name\}\}/);
  assert.doesNotMatch(report.split("\n").find(line => line.includes("letter.md"))!, /will not be sent/);
  assert.match(report, /三次/);
});
