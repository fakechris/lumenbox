/**
 * What a person does with a whole conversation on the rebuilt page (INV-1825): find something said in
 * it, take it away as Markdown, hand somebody a link to it. One quiet control in the header; nothing
 * of it is on the thread until asked for.
 */
export const NEXT_THREAD_JS = `
/** The conversation as Markdown: what was said, by whom, in order. Steps and asides stay behind. */
function threadMarkdown(entries, agentName, you) {
  var out = [];
  entries.forEach(function (entry) {
    if (entry.kind !== "text" || entry.aside || !entry.text) return;
    out.push("## " + (entry.role === "user" ? you : agentName) + (entry.at ? " · " + String(entry.at).slice(0, 16).replace("T", " ") : ""));
    out.push(entry.text.trim());
  });
  return out.join("\\n\\n") + "\\n";
}

/** Whether an entry is something said that holds what is being looked for. */
function threadFinds(entry, wanted) {
  return entry.kind === "text" && !entry.aside && String(entry.text || "").toLowerCase().indexOf(wanted) >= 0;
}

function closeFind() { chat.find = ""; $("find").hidden = true; $("find-text").value = ""; render(); }

function threadStart() {
  var menu = $("thread-menu");
  $("thread-more").addEventListener("click", function (event) { event.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener("click", function () { menu.hidden = true; });
  $("thread-find").addEventListener("click", function () { $("find").hidden = false; $("find-text").focus(); });
  $("find-text").addEventListener("input", function () { chat.find = $("find-text").value.trim().toLowerCase(); render(); });
  $("find-text").addEventListener("keydown", function (event) { if (event.key === "Escape") closeFind(); });
  $("find-close").addEventListener("click", closeFind);
  $("thread-export").addEventListener("click", function () {
    var agent = next.agents[chat.agentId], name = agent ? agent.name : "";
    var link = el("a"), url = URL.createObjectURL(new Blob([threadMarkdown(chat.entries, name, t("ui.next.thread.you"))], { type: "text/markdown" }));
    link.href = url; link.download = (name || "conversation") + "-" + new Date().toISOString().slice(0, 10) + ".md";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  $("thread-link").addEventListener("click", function () {
    var url = location.origin + "/?agent=" + encodeURIComponent(chat.agentId) + "&conversation=" + encodeURIComponent(chat.conversation);
    navigator.clipboard.writeText(url).then(function () { toast(t("ui.next.thread.linkCopied")); }, failed);
  });
}

/** The header control belongs to a conversation; the count says how much of it matched. */
function renderThreadTools(found) {
  var shown = next.view === "chat" && !!next.agents[chat.agentId];
  $("thread-more").hidden = !shown;
  if (!shown) { $("find").hidden = true; $("thread-menu").hidden = true; }
  $("find-count").textContent = chat.find ? t("ui.next.thread.found", { n: found }) : "";
}
`;
