/**
 * What the app does when the server refuses the home (docs/05 §2.0, INV-2201).
 *
 * `agentbox web` exits with this status when the data in the home is newer than this app, cannot
 * be read as a format, or could not be upgraded. That is not a crash: starting it again changes
 * nothing, so the shell does not retry — it shows the server's own sentence (which format was
 * found, which version to install) and quits. Mirrors HOME_REFUSED_EXIT in src/home-format.ts;
 * home-format.test.ts holds the two numbers together.
 */
const HOME_REFUSED_EXIT = 78;

/** The dialog for a refused home, from the server's last output: its `error: …` line, whole. */
function homeRefusal(recentLog) {
  const said = [...recentLog].reverse().find(line => line.startsWith("error: "));
  return {
    title: "LumenBox cannot open its data",
    message: said !== undefined ? said.slice("error: ".length) : recentLog.slice(-5).join("\n") || "The server refused the data in its home directory and did not say why. See the server log.",
  };
}

module.exports = { HOME_REFUSED_EXIT, homeRefusal };
