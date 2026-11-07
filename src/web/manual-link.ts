/**
 * Where the user manual lives (INV-1683): the rendered `docs/manual/README.md` on GitHub.
 *
 * The app links to it rather than bundling the pages, so the manual a person reads is the one
 * on main, not the one their build happened to ship. One home for the URL: the top bar's
 * Manual link interpolates it, and the desktop shell sends it to the system browser.
 */
export const MANUAL_URL = "https://github.com/fakechris/lumenbox/blob/main/docs/manual/README.md";

/** The Chinese manual (INV-1684), beside the English one: the page links to the one in its reader's language. */
export const MANUAL_URL_ZH = MANUAL_URL.replace(/\.md$/, ".zh.md");

/** The page a personal installation's refused add-person links to (INV-1689): its Limits say the installation has only you. */
export const PERSONAL_ONLY_PAGE = "channels";

/** One manual page in the reader's language: `manualPage("channels", "zh")` is `channels.zh.md` beside the Chinese README. */
export function manualPage(page: string, locale: "zh" | "en"): string {
  return MANUAL_URL.replace(/README\.md$/, locale === "zh" ? `${page}.zh.md` : `${page}.md`);
}
