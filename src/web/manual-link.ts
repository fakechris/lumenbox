/**
 * Where the user manual lives (INV-1683): the rendered `docs/manual/README.md` on GitHub.
 *
 * The app links to it rather than bundling the pages, so the manual a person reads is the one
 * on main, not the one their build happened to ship. One home for the URL: the top bar's
 * Manual link interpolates it, and the desktop shell sends it to the system browser.
 */
export const MANUAL_URL = "https://github.com/fakechris/lumenbox/blob/main/docs/manual/README.md";
