/**
 * The dock badge and the system notices, across every installation the app is a client of
 * (INV-1626 for the personal one, INV-1709 for the joined organisations).
 *
 * Two inputs: the personal server's agents (main.cjs readAgentFacts, every ten seconds and after a
 * turn or a consent) and the organisations' counts (installation-views.cjs, every count read). One
 * badge from both, and the notices each is due, through the gates in attention-signals.cjs.
 *
 * Electron-free: what to do with a badge, a notice and the shell's words is handed in, so the
 * rehearsal drives this exactly as the shell does.
 */
const { execFile } = require("node:child_process");
const path = require("node:path");
const { dockCount, notificationsDue, organisationNotice, organisationNoticesDue } = require("./attention-signals.cjs");

/**
 * `setBadge(n)`, `notify(title, body, { silent, agentId } | { installationId })`, `focused()` —
 * whether the person is looking at the window — and `words()`, the shell's words (shellWordsReader).
 */
function dockSignals({ setBadge, notify, focused, words, now = Date.now, log = () => {} }) {
  let agents = [];
  let organisations = [];
  const sent = new Map();
  const needs = new Map();
  const show = () => setBadge(dockCount(agents, organisations));

  /** The personal server's agents, as /api/state reported them. */
  function agentsRead(current) {
    for (const due of notificationsDue(agents, current, focused(), now(), sent)) notify(due.title, due.body, { silent: due.silent, agentId: due.agentId });
    agents = current;
    show();
  }

  /** A count read of the joined organisations finished: ids, names and numbers, no token. */
  function organisationsRead(current) {
    organisations = current;
    show();
    const due = organisationNoticesDue(needs, current, focused(), now(), sent);
    if (due.length === 0) return Promise.resolve();
    return Promise.resolve(words()).then(said => {
      for (const notice of due) {
        const { title, body } = organisationNotice(notice, said);
        notify(title, body, { installationId: notice.installationId });
      }
    }).catch(error => log(`organisation notice not sent: ${error.message}`));
  }

  return { agentsRead, organisationsRead };
}

/**
 * The shell's own words (src/i18n/shell-words.ts) in the person's language: `choice()` is what they
 * picked on the personal page (its `lumen-lang` cookie), which wins over `languages()`, the
 * system's. Rendered by a child, like the first-run page (the shell does not load TypeScript), and
 * kept per choice; a failed render is not kept, so the next notice tries again.
 */
function shellWordsReader({ execPath, repo, languages, choice, env = process.env }) {
  const byChoice = new Map();
  return async function words() {
    const picked = String((await choice()) || "");
    const asked = /^[A-Za-z-]{1,16}$/.test(picked) ? picked : "";
    if (!byChoice.has(asked)) {
      const script = path.join(repo, "src", "web", "shell-words-print.ts");
      byChoice.set(asked, new Promise((resolve, reject) => {
        execFile(execPath, ["--experimental-transform-types", script, languages().join(","), asked], { cwd: repo, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 60_000 }, (error, stdout) => {
          try {
            if (error) throw new Error(`the shell's words did not render: ${error.message}`);
            resolve(JSON.parse(String(stdout)).words);
          } catch (failure) {
            byChoice.delete(asked);
            reject(failure);
          }
        });
      }));
    }
    return byChoice.get(asked);
  };
}

module.exports = { dockSignals, shellWordsReader };
