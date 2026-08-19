/**
 * The Markdown the chat feed needs, and nothing more.
 *
 * Agents write Markdown — fenced code, lists, bold, headings — and the feed showed
 * it verbatim, so a code block arrived as a wall of backticks.
 *
 * Escape first, then format. Every `<` and `&` in the model's text becomes an entity
 * before a single tag is added, so nothing the model writes can become HTML. That is
 * the whole reason there is no sanitizer here and no dependency on one: the other
 * arrangement — render Markdown, then try to clean the HTML up — is where XSS bugs
 * live, and the model's output is not trusted input.
 *
 * Two constraints shape the code. It is injected into the page as source text, via
 * String(renderMarkdown), so it must stay self-contained: no imports, no module-level
 * helpers, nothing from any enclosing scope. And it runs on every streamed delta
 * against a message that is still being written, so an unterminated fence has to
 * render as a code block rather than as literal backticks.
 *
 * Deliberately not supported: tables, reference links, HTML passthrough, footnotes,
 * setext headings. A table degrades to its pipe-and-dash source, which is legible;
 * the rest have not shown up in agent output.
 */
export function renderMarkdown(source: string): string {
  var text = source == null ? "" : String(source);

  // Code is held out of the formatting passes behind these two markers, so they must
  // not survive in the text itself. Stripping them costs nothing and removes the one
  // input that could forge a placeholder.
  var BLOCK = "\u0000";
  var SPAN = "\u0001";

  text = text.replace(/[\u0000\u0001]/g, "").replace(/\r\n?/g, "\n");
  text = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  var codeBlocks: string[] = [];
  var codeSpans: string[] = [];

  // Fenced code first, so nothing inside it is reinterpreted later. A fence that
  // never closes still becomes a block: mid-stream that is the common case, not an
  // error.
  var lines = text.split("\n");
  var held: string[] = [];
  for (var i = 0; i < lines.length; i++) {
    var opening = /^[ \t]*(```|~~~)/.exec(lines[i]!);
    if (!opening) {
      held.push(lines[i]!);
      continue;
    }
    var closing = new RegExp("^[ \\t]*" + opening[1]!);
    var body: string[] = [];
    for (i++; i < lines.length && !closing.test(lines[i]!); i++) body.push(lines[i]!);
    codeBlocks.push("<pre><code>" + body.join("\n") + "</code></pre>");
    held.push(BLOCK + (codeBlocks.length - 1) + BLOCK);
  }

  text = held
    .join("\n")
    // Inline code, likewise held out: its content is literal, not Markdown.
    .replace(/`([^`\n]+)`/g, function (_all, code) {
      codeSpans.push("<code>" + code + "</code>");
      return SPAN + (codeSpans.length - 1) + SPAN;
    });

  var inline = function (value: string): string {
    return value
      // Only schemes that cannot execute. A rejected href leaves the source text
      // visible, which is the honest outcome — better than a dead or hostile link.
      .replace(/\[([^\]\n]*)\]\(([^\s)]+)\)/g, function (all, label, href) {
        return /^(https?:\/\/|mailto:|\/)/i.test(href)
          ? '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' +
              label +
              "</a>"
          : all;
      })
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
      // The guards keep intra-word underscores (snake_case) and stray asterisks from
      // turning into emphasis, which is how identifiers get mangled.
      .replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  };

  /** One run of list items, nested by indent. Items are single-line here. */
  var takeList = function (all: string[], from: number): { html: string; next: number } {
    var stack: { tag: string; indent: number }[] = [];
    var html = "";
    var at = from;

    while (at < all.length) {
      var match = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(all[at]!);
      if (!match) {
        // A blank line inside a list is a gap, not a terminator.
        var gap =
          /^[ \t]*$/.test(all[at]!) &&
          at + 1 < all.length &&
          /^[ \t]*([-*+]|\d{1,9}[.)])[ \t]+/.test(all[at + 1]!);
        if (!gap) break;
        at++;
        continue;
      }

      var indent = match[1]!.replace(/\t/g, "  ").length;
      var tag = /^\d/.test(match[2]!) ? "ol" : "ul";

      while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) {
        html += "</li></" + stack.pop()!.tag + ">";
      }
      if (stack.length === 0) {
        stack.push({ tag: tag, indent: indent });
        html += "<" + tag + ">";
      } else if (indent > stack[stack.length - 1]!.indent + 1) {
        // Deeper: the new list opens inside the item above, which stays open.
        stack.push({ tag: tag, indent: indent });
        html += "<" + tag + ">";
      } else if (tag !== stack[stack.length - 1]!.tag) {
        // A change of marker at the same depth is a new list, not a sibling item:
        // otherwise numbered steps following bullets inherit the bullets and lose
        // their numbers.
        html += "</li></" + stack.pop()!.tag + ">";
        stack.push({ tag: tag, indent: indent });
        html += "<" + tag + ">";
      } else {
        html += "</li>";
      }
      html += "<li>" + inline(match[3]!);
      at++;
    }

    while (stack.length) html += "</li></" + stack.pop()!.tag + ">";
    return { html: html, next: at };
  };

  var blocks: string[] = [];
  var paragraph: string[] = [];
  var flush = function () {
    if (!paragraph.length) return;
    // A single newline is a line break. Chat is written the way people type, not the
    // way Markdown specifies paragraphs.
    blocks.push("<p>" + inline(paragraph.join("<br>")) + "</p>");
    paragraph = [];
  };

  var rows = text.split("\n");
  var row = 0;
  while (row < rows.length) {
    var line = rows[row]!;

    if (/^[ \t]*$/.test(line)) {
      flush();
      row++;
      continue;
    }
    // A held code block stands alone; wrapping it in a paragraph would nest <pre>.
    if (new RegExp("^" + BLOCK + "\\d+" + BLOCK + "$").test(line.trim())) {
      flush();
      blocks.push(line.trim());
      row++;
      continue;
    }
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line)) {
      flush();
      blocks.push("<hr>");
      row++;
      continue;
    }

    var heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
    if (heading) {
      flush();
      var level = heading[1]!.length;
      blocks.push("<h" + level + ">" + inline(heading[2]!.trim()) + "</h" + level + ">");
      row++;
      continue;
    }

    // `>` is already an entity by this point.
    if (/^ {0,3}&gt;[ \t]?/.test(line)) {
      flush();
      var quoted: string[] = [];
      while (row < rows.length && /^ {0,3}&gt;[ \t]?/.test(rows[row]!)) {
        quoted.push(rows[row]!.replace(/^ {0,3}&gt;[ \t]?/, ""));
        row++;
      }
      blocks.push("<blockquote>" + inline(quoted.join("<br>")) + "</blockquote>");
      continue;
    }

    if (/^[ \t]*([-*+]|\d{1,9}[.)])[ \t]+/.test(line)) {
      flush();
      var list = takeList(rows, row);
      blocks.push(list.html);
      row = list.next;
      continue;
    }

    paragraph.push(line.trim());
    row++;
  }
  flush();

  return blocks
    .join("")
    .replace(new RegExp(SPAN + "(\\d+)" + SPAN, "g"), function (_all, index) {
      return codeSpans[Number(index)] ?? "";
    })
    .replace(new RegExp(BLOCK + "(\\d+)" + BLOCK, "g"), function (_all, index) {
      return codeBlocks[Number(index)] ?? "";
    });
}
