/**
 * What the desktop app tells the OS about the agents (INV-1626): a dock badge, and two kinds of
 * notification — "needs you" when an agent starts waiting on the person, and "done" when a turn
 * ends with something new to read. Nothing while the window is focused, and nothing twice in
 * five seconds for the same agent and kind: a channel that carries everything carries nothing.
 *
 * Pure: given the agents as the server reports them (with their `facts`), the previous report,
 * and the clock, it says what to show. The main process owns the side effects.
 */

const THROTTLE_MS = 5_000;

/** The dock number: every unread message across the agents a person can see. */
function badgeCount(agents) {
  let total = 0;
  for (const agent of agents) total += Math.max(0, Math.floor((agent.facts && agent.facts.unreadCount) || 0));
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

function allowed(sent, agentId, kind, now) {
  const key = `${agentId}\u0000${kind}`;
  const last = sent.get(key);
  if (last !== undefined && now - last < THROTTLE_MS) return false;
  sent.set(key, now);
  return true;
}

module.exports = { badgeCount, notificationsDue, THROTTLE_MS };
