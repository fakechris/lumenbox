/**
 * The classic page's settings, shown inside the rebuilt page (INV-1825).
 *
 * The rebuilt page does not yet have its own model, channel, team, memory, supervision and guest
 * settings. Rather than send a person to another page for them, it opens the
 * classic page in a frame with `?embed=settings&tab=…`: the classic page then
 * shows that one dialog and nothing else, and tells the page that framed it when the dialog closes.
 * A bridge, to be removed pane by pane as each is rebuilt.
 */
export const EMBED_STYLE = `
html[data-embed] body { background: transparent; }
html[data-embed] body > *:not(#settingswrap) { display: none !important; }
`;

export const EMBED_JS = `
(function () {
  var query = new URLSearchParams(location.search), embed = query.get("embed");
  if (embed !== "settings") return;
  document.documentElement.setAttribute("data-embed", embed);
  var wrap = $("settingswrap"), opened = false;
  function closed() { if (window.parent !== window) window.parent.postMessage({ lumen: "embed-closed", embed: embed }, location.origin); }
  // Told once, when the dialog that was opened is closed again: the framing page takes the frame away.
  new MutationObserver(function () {
    if (wrap.style.display !== "none") { opened = true; return; }
    if (opened) closed();
  }).observe(wrap, { attributes: true, attributeFilter: ["style"] });
  openSettings(query.get("tab") || "model");
  opened = wrap.style.display !== "none";
})();
`;

/**
 * The classic page with the bridge added: its style first in the page's own, its script last in the
 * body, after everything it calls is defined. Done here, not in app-html.ts, which may only shrink.
 */
export function withEmbed(html: string): string {
  const style = html.indexOf("<style>"), body = html.lastIndexOf("</body>");
  if (style < 0 || body < 0) throw new Error("the classic page has no <style> or </body> to carry the embed bridge");
  const styled = html.slice(0, style + "<style>".length) + EMBED_STYLE + html.slice(style + "<style>".length, body);
  return `${styled}<script>${EMBED_JS}</script>\n${html.slice(body)}`;
}
