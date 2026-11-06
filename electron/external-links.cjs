/**
 * What the desktop window does with a link that would open a new window or navigate it
 * away (INV-1683).
 *
 * A page off the app's own origin — the manual on GitHub, a link an agent wrote — goes to the
 * system browser and the window stays the app: an Electron child window has no address bar,
 * no back button and none of the person's logins, and navigating in place loses the app. A
 * same-origin page (a desktop, a file) keeps the default, because it needs the app's session.
 * Takes `openExternal` as an argument so the decision is testable without Electron.
 */
function windowOpenAction(url, appOrigin, openExternal) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return { action: "deny" };
  }
  if (target.origin === appOrigin) return { action: "allow" };
  if (target.protocol === "https:" || target.protocol === "http:" || target.protocol === "mailto:") void openExternal(target.href);
  return { action: "deny" };
}

module.exports = { windowOpenAction };
