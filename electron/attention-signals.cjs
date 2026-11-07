/**
 * What the desktop app tells the OS about the agents (INV-1626): a dock badge, and two kinds of
 * notification — "needs you" when an agent starts waiting on the person, and "done" when a turn
 * ends with something new to read. Nothing while the window is focused, and nothing twice in
 * five seconds for the same agent and kind: a channel that carries everything carries nothing.
 *
 * The joined organisations count too (INV-1709): their unread in the badge, and a notice when one
 * of them starts having something waiting for the person.
 *
 * Pure: given the agents as the server reports them (with their `facts`), the organisations'
 * counts as the shell read them, the previous report, and the clock, it says what to show. The
 * main process owns the side effects.
 */

const THROTTLE_MS = 5_000;

/** Every unread message across the agents a person can see in one installation. */
function badgeCount(agents) {
  let total = 0;
  for (const agent of agents) total += Math.max(0, Math.floor((agent.facts && agent.facts.unreadCount) || 0));
  return total;
}

/**
 * The dock number (INV-1709): the personal installation's unread plus each joined organisation's,
 * as the shell last read them (installations.cjs installationList entries). An organisation whose
 * count could not be read adds nothing: it is unknown, and the column says "—", not 0 — but the
 * dock has one number, and a guess in it would be a number nobody can check.
 */
function dockCount(agents, organisations = []) {
  let total = badgeCount(agents);
  for (const org of organisations) if (!org.unknown) total += Math.max(0, Math.floor(Number(org.unread) || 0));
  return total;
}

/**
 * The notifications due between two reports.
 * `previous` and `current` are the server's agents arrays; `focused` is whether the window has
 * the person's attention; `sent` is the ledger of what went out, mutated here.
 */
function notificationsDue(previous, current, focused, now, sent) {
  if (focused) return [];
  const before = new Map(previous.map(agent => [agent.id, agent]));
  const due = [];
  for (const agent of current) {
    const was = before.get(agent.id);
    const facts = agent.facts || {};
    const wasFacts = (was && was.facts) || {};
    if (facts.awaiting && !wasFacts.awaiting && allowed(sent, agent.id, "needs-you", now)) {
      due.push({ kind: "needs-you", agentId: agent.id, title: `${agent.name} needs you`, body: facts.awaiting.reason || "Waiting for your answer.", silent: false });
    } else if (was && was.running && !agent.running && !facts.awaiting && (facts.unreadCount || 0) > (wasFacts.unreadCount || 0) && allowed(sent, agent.id, "done", now)) {
      due.push({ kind: "done", agentId: agent.id, title: agent.name, body: "Finished and said something. Open LumenBox to read it.", silent: true });
    }
  }
  return due;
}

/**
 * The organisation notices due after a count read (INV-1709): one when what an organisation owes
 * the person goes from none to some — "<organisation> has N waiting for you", the name and a number
 * and nothing else, because the shell only ever reads counts and the items behind them stay inside
 * the organisation. Same gate as an agent's needs-you: nothing while the window is focused, nothing
 * twice in five seconds for the same organisation.
 *
 * `known` maps an organisation id to the last needs-you count that was read, and is updated here.
 * A read that failed leaves it as it was, so an organisation that drops off the network and comes
 * back with the same items is not news. The first read of an organisation counts from zero, as
 * the agents' first report does: what is waiting when the app starts is said once.
 */
function organisationNoticesDue(known, organisations, focused, now, sent) {
  const due = [];
  for (const org of organisations) {
    if (org.unknown) continue;
    const count = Math.max(0, Math.floor(Number(org.needsYou) || 0));
    const was = known.get(org.id) || 0;
    known.set(org.id, count);
    if (focused || count === 0 || was > 0) continue;
    if (allowed(sent, `installation\u0000${org.id}`, "needs-you", now)) due.push({ kind: "organisation-needs-you", installationId: org.id, name: org.name, count, silent: false });
  }
  for (const id of [...known.keys()]) if (!organisations.some(org => org.id === id)) known.delete(id);
  return due;
}

/**
 * The notice's text, from the shell's words (src/i18n/shell-words.ts, printed for the shell by
 * src/web/shell-words-print.ts): the organisation's name and the count, nothing else.
 */
function organisationNotice(due, words) {
  const fill = key => String(words[key] || key).replace(/\{(\w+)\}/g, (whole, name) => (name === "organisation" ? due.name : name === "count" ? String(due.count) : whole));
  return { title: fill("shell.organisation-needs-you.title"), body: fill("shell.organisation-needs-you.body") };
}

function allowed(sent, agentId, kind, now) {
  const key = `${agentId}\u0000${kind}`;
  const last = sent.get(key);
  if (last !== undefined && now - last < THROTTLE_MS) return false;
  sent.set(key, now);
  return true;
}

module.exports = { badgeCount, dockCount, notificationsDue, organisationNotice, organisationNoticesDue, THROTTLE_MS };
