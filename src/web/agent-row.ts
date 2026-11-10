/** Sidebar facts occupy stable columns; text and counters never resize each other (INV-1792). */
// Shared space/type tokens arrive with the deferred UI bundle; match them before it loads too.
export const AGENT_ROW_STYLE = String.raw`
  .agent {
    margin: 0 var(--sp-2, 8px) calc(var(--sp-1, 4px) / 2); padding: var(--sp-2, 8px); cursor: pointer; border-radius: var(--radius-input);
    display: grid; grid-template-columns: var(--sp-2, 8px) minmax(0, 1fr) calc(var(--sp-3, 12px) * 2 + var(--sp-1, 4px)) calc(var(--sp-4, 16px) * 2);
    gap: var(--sp-2, 8px); align-items: center; transition: background var(--dur) var(--ease);
  }
  .agent:hover { background: var(--surface-hover); }
  .agent.on { background: var(--accent-soft); }
  .agent.on .nm, .agent.on .ttl, .agent.on .dnum { color: var(--accent); }
  .agent > .dot { grid-column: 1; grid-row: 1; }
  .agent .cols { grid-column: 2; grid-row: 1; min-width: 0; }
  .agent .nm { font-weight: 600; font-size: var(--fs-body, 15px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .agent .ttl { color: var(--muted); font-size: var(--fs-xs, 11px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .agent.blocked .ttl { color: var(--warn); }
  .agent .cnt {
    grid-column: 3; grid-row: 1; display: flex; align-items: center; justify-content: center;
    min-width: 0; width: 100%; height: calc(var(--sp-4, 16px) + var(--sp-1, 4px)); padding: 0; border-radius: var(--radius-pill);
    background: var(--accent); color: var(--on-accent); font-size: var(--fs-xs, 11px); font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .agent .dnum {
    grid-column: 4; grid-row: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--font-mono); font-size: var(--fs-xs, 11px); color: var(--muted); font-variant-numeric: tabular-nums; text-align: center;
  }
`;

export const AGENT_ROW_JS = String.raw`
function oneAgentRow(a, index) {
  // Marker precedence is unchanged: waiting on the person, then unread, then working (INV-1625).
  var f = a.facts || {}, marker = f.awaiting ? "blocked" : f.unreadCount > 0 ? "unread" : busy.has(a.id) ? "busy" : "";
  var line = f.awaiting ? "{{ui.app.waiting-for-you}} " + f.awaiting.reason : busy.has(a.id) ? "{{ui.app.running}}" : String(a.title || a.description || "{{ui.app.idle}}").slice(0, 40);
  var unread = "{{ui.app.agent-unread-count}}".replace("{count}", String(f.unreadCount));
  var desktop = "{{ui.app.agent-desktop-number}}".replace("{display}", String(a.displayIndex));
  return '<div class="agent ' + (a.id === current ? "on" : "") + (marker ? " " + marker : "") + '" data-id="' + esc(a.id) + '" title="' + esc(f.awaiting ? f.awaiting.reason : "") + '">' +
    '<div class="dot ' + marker + '" style="background:var(--c-' + ((index % 8) + 1) + ')"></div>' +
    '<div class="cols"><div class="nm" title="' + esc(a.name) + '">' + esc(a.name) + '</div><div class="ttl">' + esc(line) + '</div></div>' +
    (f.unreadCount > 0 ? '<span class="cnt" title="' + esc(unread) + '" aria-label="' + esc(unread) + '">' + (f.unreadCount > 99 ? "99+" : f.unreadCount) + '</span>' : '') +
    (a.displayIndex ? '<span class="dnum" title="' + esc(desktop) + '" aria-label="' + esc(desktop) + '">d' + esc(a.displayIndex) + '</span>' : '') + '</div>';
}
`;
