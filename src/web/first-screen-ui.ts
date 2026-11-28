/**
 * The first screen on the rebuilt page (INV-2311, docs/112 §3, §4): the sidebar's sandbox headings
 * and the getting-started card. What they say is decided in first-screen.ts; this draws it and
 * carries out a press.
 *
 * The sidebar opens with the person's sandbox as a heading — "Your sandbox · Ready" — and the agents
 * in it under it; a person who may use more than one sandbox sees each as a heading, and pressing one
 * makes it the one a new agent goes in. A sandbox that is not ready says why under its heading, with
 * the one button that works.
 */
export const FIRST_SCREEN_CSS = `
.sandbox-line { display: flex; align-items: center; gap: 6px; margin: 10px 0 2px; } .sandbox-line:first-child { margin-top: 0; }
.sandbox-line .act { padding: 3px 10px; font-size: 12px; margin-right: 30px; }
.sandbox-head { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; padding: 4px 8px; border-radius: 8px; text-align: left; font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: .04em; }
.sandbox-head[aria-pressed="true"] { color: var(--text); }
.sandbox-state { font-weight: 500; }
.sandbox-state[data-state="failed"] { color: var(--bad); } .sandbox-state[data-state="preparing"] { color: var(--blue); }
.sandbox-why { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; margin: 0 8px 6px; padding: 8px 10px; border-radius: 10px; background: var(--bad-soft); color: var(--bad); font-size: 13px; }
.sandbox-why[data-state="stopped"], .sandbox-why[data-state="preparing"] { background: var(--rail); color: var(--soft); }
/* The add button rides on the first sandbox heading's line: the sidebar opens with the sandbox, not a label (docs/112 §4). */
.side-add { display: flex; justify-content: flex-end; height: 0; margin: 0 6px; position: relative; top: 2px; z-index: 1; }
.sandbox-why pre { max-width: 100%; max-height: 120px; overflow: auto; font-size: 11px; color: var(--soft); margin: 0; }
`;

export const FIRST_SCREEN_JS = `
/** An organisation's page, as the server says: Settings → Organisation is there, and the public address and activation live in it. */
function isOrganisation() { return !!(settings.setup && settings.setup.edition === "organisation"); }

/** The sandboxes this person has a heading for, with their state (first-screen.ts). */
function mySandboxes(known) {
  var state = boxes.state || {}, docker = state.docker && state.docker.state ? state.docker.state : "";
  return sandboxesOf(known, { edition: (settings.setup && settings.setup.edition) || "personal", admin: canOperateInstallation(), own: boxes.own,
    starting: !!boxes.starting, failed: boxes.failed || "", docker: docker, auto: settings.setup && settings.setup.autoBox });
}

/** "Your sandbox · Ready", or the sandbox's name for one that is not theirs. */
function sandboxTitle(box) { return box.yours ? t("ui.first.yours") : box.name; }

/** A sandbox's heading in the sidebar: pressed, it is the one the list adds to; a sandbox that is not ready carries its one button on this line. */
function sandboxHeading(box) {
  var line = el("div", "sandbox-line"), head = el("button", "sandbox-head");
  head.setAttribute("aria-pressed", String(box.id === chat.box));
  head.appendChild(el("span", "", sandboxTitle(box) + " ·"));
  var state = el("span", "sandbox-state", t("ui.first.state." + box.state)); state.dataset.state = box.state;
  head.appendChild(state);
  head.addEventListener("click", function () { if (box.id && box.id !== chat.box) { chat.box = box.id; chat.agentId = ""; render(); } });
  line.appendChild(head);
  var act = box.state === "ready" || box.state === "preparing" ? undefined : sandboxActOf(box);
  if (act) {
    var press = el("button", "act", t(act.words, act.vars));
    press.disabled = !!boxes.starting;
    press.addEventListener("click", function () { goTo(act.to); });
    line.appendChild(press);
  }
  return line;
}

/** Under a sandbox that failed: why (its button is on the heading line). While the installation's own one starts: what Docker says. */
function sandboxWhy(box) {
  var starting = box.id === boxes.own && (boxes.starting || boxes.log.length) && box.state !== "ready";
  if (box.state !== "failed" && !starting) return null;
  var why = el("div", "sandbox-why"); why.dataset.state = box.state;
  if (box.reason) why.appendChild(el("span", "", t("ui.first.why." + box.reason)));
  if (box.detail) why.appendChild(el("pre", "", box.detail));
  if (starting) { var log = el("pre", "box-log"); log.textContent = boxes.log.slice(-8).join(String.fromCharCode(10)); why.appendChild(log); }
  return why;
}

/** Carries out a press of the first screen: the act itself, or the exact place where it is done. */
function goTo(to) {
  if (to.pane) openSettingsPane(to.pane);
  else if (to.chat) openChat(to.chat);
  else if (to.start) startBox();
  else if (to.retry) postJson("/api/personal-boxes/retry", { id: to.retry }).then(function () { refreshSoon(); }, failed);
  else if (to.url) window.open(to.url, "_blank", "noopener");
  else if (to.create) createSetupBox();
  else if (to.newAgent) openMember("");
}

/** Remembered in this browser, per installation and person: a step done once is not asked again. */
function firstScreenKey(what) {
  var state = settings.setup || {};
  return "lumen-first:" + what + ":" + (state.installationId || "") + ":" + ((settings.me && settings.me.identity) || "operator");
}
function firstScreenSeen(what) { try { return localStorage.getItem(firstScreenKey(what)) === "1"; } catch (error) { return false; } }
function firstScreenSee(what) { try { localStorage.setItem(firstScreenKey(what), "1"); } catch (error) {} }
/** Whether the sandbox step had shown it ready on an earlier visit: read once per page load, so its tick stays for this one. */
var firstScreenReadyBefore = null;

/** Making the person's own sandbox from the list, on an organisation that does not make one at first sign-in. */
function createSetupBox() {
  if (settings.creatingBox) return;
  settings.boxRequest = settings.boxRequest || crypto.randomUUID();
  settings.creatingBox = true; render();
  postJson("/api/personal-boxes/create", { requestId: settings.boxRequest }).then(function (got) {
    var box = (got.boxes || []).find(function (row) { return row.id === got.boxId; });
    if (!box || box.status !== "ready") throw new Error(box && box.error || t("ui.first.why.other"));
    settings.boxRequest = ""; chat.box = box.id; chat.agentId = "";
    chat.entries = []; chat.live = null; chat.liveSurfaces = {}; chat.plan = null;
    chat.conversation = "main"; chat.loading = ""; chat.loadedFor = ""; chat.request++;
    chat.find = ""; chat.focus = "";
  }).catch(failed).finally(function () { settings.creatingBox = false; refresh(); });
}

/** The agent the list offers to talk to: the one this person's direct messages reach, else the first in their own sandbox. */
function firstAgentOf(yours) {
  var home = settings.me && settings.me.homeAgentId && next.agents[settings.me.homeAgentId];
  if (home) return home;
  var all = Object.keys(next.agents).map(function (id) { return next.agents[id]; });
  return all.filter(function (agent) { return yours && yours.id && agent.boxId === yours.id; })[0] || (yours ? undefined : all[0]);
}

/**
 * Getting started (docs/112 §4), computed from this person's state and the same in both editions. Gone when nothing is
 * left on it, or when the person closes it.
 */
function setupCard() {
  var state = settings.setup;
  if (!state || !canDriveAgents()) return null;
  var admin = canOperateInstallation(), card = el("div", "card-plain");
  if (admin && state.bootstrapPending) {
    var link = el("a", "act", t("ui.channels.bootstrap-pending"));
    link.href = "/bootstrap"; card.appendChild(link);
  }
  var yours = mySandboxes(boxesKnown()).filter(function (box) { return box.yours; })[0], agent = firstAgentOf(yours);
  // What has happened in their sandbox: an installation already in use has nothing to start (as before INV-2311), and closed stays closed.
  var here = (state.byBox && yours && state.byBox[yours.id]) || {}, legacy = "lumen-setup-closed:" + state.installationId + ":" + ((settings.me && settings.me.identity) || "operator") + ":" + chat.box;
  var closed = firstScreenSeen("closed"); try { closed = closed || localStorage.getItem(legacy) === "1"; } catch (error) {}
  settings.listShowsModel = false;
  if (closed || here.established) return card.firstChild ? card : null;
  var auto = state.autoBox, organisation = isOrganisation();
  var steps = gettingStartedOf({ admin: admin, key: state.key, door: !!state.door, yours: yours, quota: !!(auto && auto.state === "quota"),
    canCreate: organisation && !yours && !auto && state.hasPersonalBox === false, readyOnce: firstScreenReadyBefore === null ? (firstScreenReadyBefore = firstScreenSeen("ready")) : firstScreenReadyBefore,
    agent: agent ? { id: agent.id, name: agent.name } : undefined, opened: firstScreenSeen("opened") || !!here.agentTurn });
  if (yours && yours.state === "ready") firstScreenSee("ready");
  settings.listShowsModel = steps.some(function (step) { return step.key === "model"; });
  if (!steps.some(function (step) { return !step.done; })) { settings.listShowsModel = false; return card.firstChild ? card : null; }
  card.appendChild(el("div", "card-head", t("ui.next.setup.title")));
  steps.forEach(function (step) {
    var row = el("div", "setup-step"), words = t(step.words, step.vars);
    row.appendChild(el("span", step.done ? "setup-done" : "setup-todo", step.done ? "✓" : "○"));
    if (step.state) words += " · " + t("ui.first.state." + step.state);
    if (step.reason) words += " · " + t("ui.first.why." + step.reason);
    row.appendChild(el("span", "body", words + (step.optional ? " " + t("ui.next.setup.optional") : "")));
    if (step.act && !step.done) {
      var go = el("button", "act", t(step.act.words, step.act.vars));
      go.disabled = (step.key === "sandbox" && (!!settings.creatingBox || !!boxes.starting));
      go.addEventListener("click", function () { goTo(step.act.to); });
      row.appendChild(go);
    }
    card.appendChild(row);
  });
  var close = el("button", "act", t("ui.next.act.close"));
  close.addEventListener("click", function () { firstScreenSee("closed"); render(); });
  card.appendChild(close);
  return card;
}
`;
