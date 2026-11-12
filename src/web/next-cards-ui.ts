/**
 * What an agent puts in front of a person inside their conversation (INV-1825): a consent it needs,
 * a secret, its desktop handed over, credentials a job is missing, and the cards it draws itself.
 *
 * Each is something only the person can settle, shown where they are already talking to the agent
 * that asked. The state is read from the same endpoints the classic page polls, because two of
 * these — an approval answered in a chat, one that expired — end without any event.
 */
export const NEXT_CARDS_JS = `
var cards = { approvals: [], secrets: [], handovers: [], credentials: {}, surfaces: {}, vendor: "idle", waiting: [] };

function loadCards() {
  var none = function () { return {}; };
  Promise.all([getJson("/api/policy").catch(none), getJson("/api/secrets/requests").catch(none), getJson("/api/handover").catch(none)]).then(function (got) {
    var before = JSON.stringify([cards.approvals, cards.secrets, cards.handovers]);
    cards.approvals = got[0].pending || []; cards.secrets = got[1].requests || []; cards.handovers = got[2].pending || [];
    if (before !== JSON.stringify([cards.approvals, cards.secrets, cards.handovers]) && next.view === "chat") render();
  });
}

function cardBox(tone, heading) {
  var box = el("div", "card-" + tone);
  box.appendChild(el("div", "card-head", heading));
  return box;
}

function approvalCard(approval, agent) {
  var box = cardBox("need", t("ui.next.card.consent", { name: agent.name })), acts = el("div", "acts");
  if (approval.action) box.appendChild(el("b", "", approval.action));
  if (approval.why) box.appendChild(el("div", "why", t("ui.next.card.says", { name: agent.name, why: approval.why })));
  box.appendChild(el("code", "card-code", approval.description));
  var scopes = approval.onceOnly ? ["once"] : ["once", "session", "always"];
  scopes.forEach(function (scope, index) {
    var allow = el("button", index === 0 ? "act-primary" : "act", t("ui.next.card.allow." + scope));
    allow.addEventListener("click", function () {
      postJson("/api/approve", { id: approval.id, scope: scope }).then(function () { toast(t("ui.next.done.approved")); loadCards(); refreshSoon(); }, failed);
    });
    acts.appendChild(allow);
  });
  var refuse = el("button", "act", t("ui.next.act.deny"));
  refuse.addEventListener("click", function () {
    postJson("/api/deny", { id: approval.id }).then(function () { toast(t("ui.next.done.denied")); loadCards(); refreshSoon(); }, failed);
  });
  acts.appendChild(refuse);
  box.appendChild(acts);
  box.appendChild(el("div", "why", t("ui.next.card.scopeNote")));
  return box;
}

function secretCard(request, agent) {
  var box = cardBox("need", t("ui.next.card.secret", { name: agent.name, id: request.id })), acts = el("div", "acts"), input = el("input");
  input.type = "password"; input.autocomplete = "off";
  box.appendChild(el("div", "", request.description));
  box.appendChild(input);
  var save = el("button", "act-primary", t("ui.next.card.secretSave")), dismiss = el("button", "act", t("ui.next.card.dismiss"));
  save.addEventListener("click", function () {
    if (!input.value) { input.focus(); return; }
    var value = input.value;
    input.value = ""; // never left on the page once it is on its way
    postJson("/api/secrets/requests/answer", { id: request.id, value: value }).then(function () { toast(t("ui.next.card.secretSaved")); loadCards(); }, failed);
  });
  dismiss.addEventListener("click", function () { postJson("/api/secrets/requests/dismiss", { id: request.id }).then(loadCards, failed); });
  acts.appendChild(save); acts.appendChild(dismiss);
  box.appendChild(acts);
  box.appendChild(el("div", "why", t("ui.next.card.secretNote", { name: agent.name })));
  return box;
}

function handoverCard(handover, agent) {
  var box = cardBox("need", t("ui.next.card.handover", { name: agent.name, reason: handover.reason || "" })), acts = el("div", "acts");
  box.appendChild(el("div", "", handover.instruction));
  var open = el("a", "act-primary", t("ui.next.card.openComputer")), back = el("button", "act", t("ui.next.card.handBack"));
  open.href = handover.desktopPath || agent.desktopUrl || "#"; open.target = "_blank"; open.rel = "noopener";
  back.addEventListener("click", function () { postJson("/api/handover/back", { agent: agent.id }).then(function () { loadCards(); refreshSoon(); }, failed); });
  acts.appendChild(open); acts.appendChild(back);
  box.appendChild(acts);
  box.appendChild(el("div", "why", t("ui.next.card.handoverNote")));
  return box;
}

function credentialsCard(need, agent) {
  var box = cardBox("stuck", t("ui.next.card.credentials", { name: agent.name, title: need.title || "" }));
  (need.items || []).filter(function (item) { return item.state !== "present"; }).forEach(function (item) {
    box.appendChild(el("div", "", item.id + " — " + item.why));
  });
  var link = el("a", "act", t("ui.next.settings.openClassic"));
  link.href = "/?ui=classic";
  box.appendChild(link);
  return box;
}

/** Everything this agent is waiting on the person for, as cards at the end of its conversation. */
function pendingCards(agent) {
  var mine = function (row) { return row.agentId === agent.id; }, out = [];
  cards.approvals.filter(mine).forEach(function (row) { out.push(approvalCard(row, agent)); });
  cards.secrets.filter(mine).forEach(function (row) { out.push(secretCard(row, agent)); });
  cards.handovers.filter(mine).forEach(function (row) { out.push(handoverCard(row, agent)); });
  Object.keys(cards.credentials).forEach(function (key) { if (mine(cards.credentials[key])) out.push(credentialsCard(cards.credentials[key], agent)); });
  return out;
}

// ── Cards an agent draws itself (ShowUI). One per surface id; later messages update it in place. ──

function vendorReady(run) {
  if (window.A2UI) { run(); return; }
  cards.waiting.push(run);
  if (cards.vendor !== "idle") return;
  cards.vendor = "loading";
  var script = document.createElement("script");
  script.src = "/vendor/a2ui.js";
  script.onload = function () { cards.vendor = "ready"; var runs = cards.waiting; cards.waiting = []; runs.forEach(function (fn) { fn(); }); };
  script.onerror = function () { cards.vendor = "failed"; cards.waiting = []; if (next.view === "chat") render(); };
  document.head.appendChild(script);
}

function pressSurface(item, action) {
  if (!action || !action.name || !chat.agentId) return;
  var context = action.context && Object.keys(action.context).length ? ": " + JSON.stringify(action.context) : "";
  // The line the server parses a press from (show-ui.ts ACTION_LINE); the same in every language.
  var text = t("ui.next.card.actionLine", { name: JSON.stringify(String(action.name)), id: item.id, context: context }), now = Date.now();
  // The same press again within five seconds is somebody checking it landed, not a second choice.
  if (item.sent && item.sent.text === text && now - item.sent.at < 5000) return;
  item.sent = { text: text, at: now };
  item.done.textContent = t("ui.next.card.pressed", { name: action.name });
  postJson("/api/prompt", { agent: chat.agentId, conversation: chat.conversation, text: text, surfaceAction: { surface: item.id, name: action.name } }).catch(failed);
}

function mountSurface(item) {
  if (!window.A2UI || item.closed) return;
  if (!item.processor) {
    item.processor = new window.A2UI.MessageProcessor([window.A2UI.catalog], function (action) { pressSurface(item, action); }, { validationConfig: window.A2UI.validation });
    item.processor.onSurfaceDeleted(function () { item.closed = true; item.body.textContent = ""; });
  }
  while (item.applied < item.messages.length) {
    try { item.processor.processMessages([item.messages[item.applied]]); } catch (error) { item.done.textContent = error.message; }
    item.applied++;
  }
  if (!item.surface) {
    var surface = item.processor.getSurface(item.id);
    if (!surface) return;
    item.surface = document.createElement("a2ui-surface");
    item.surface.surface = surface;
    item.body.replaceChildren(item.surface);
  }
}

/** The card for a surface id, made once and kept: redrawing the thread moves the same node, it does not rebuild the card. */
function surfaceItem(id, title) {
  var key = chat.agentId + "/" + chat.conversation + "/" + id, item = cards.surfaces[key];
  if (!item) {
    item = cards.surfaces[key] = { id: id, messages: [], applied: 0, node: el("div", "card-plain"), body: el("div", "", t("ui.next.card.drawing")), done: el("div", "why") };
    item.head = el("div", "card-head", title || "");
    item.node.appendChild(item.head); item.node.appendChild(item.body); item.node.appendChild(item.done);
  } else if (title) item.head.textContent = title;
  return item;
}

/** Messages for a surface: from the transcript on load (the whole draw), or one live event's new part. */
function feedSurface(id, title, messages, whole) {
  var item = surfaceItem(id, title);
  if (whole) { if (messages.length > item.messages.length) item.messages = messages.slice(); }
  else item.messages = item.messages.concat(messages || []);
  if (cards.vendor === "failed") item.body.textContent = t("ui.next.card.noVendor");
  else vendorReady(function () { mountSurface(item); });
  return item.node;
}

function cardsEvent(event) {
  var kind = event.type;
  if (kind === "approval_pending" || kind === "approval_settled" || kind === "secret_requested" || kind === "handover_pending") loadCards();
  else if (kind === "credentials_needed") { cards.credentials[event.key] = event; if (next.view === "chat") render(); }
  else if (kind === "credentials_covered") { delete cards.credentials[event.key]; if (next.view === "chat") render(); }
  else if (kind === "surface" && event.agentId === chat.agentId && (event.conversation || "main") === chat.conversation) {
    feedSurface(event.surfaceId, event.title, event.messages || [], false);
    chat.liveSurfaces[event.surfaceId] = true;
    if (next.view === "chat") render();
  }
}

function cardsStart() {
  loadCards();
  // An approval answered in a chat, or one that expired, ends without an event: the poll is how its card goes away.
  setInterval(function () { if (document.visibilityState === "visible") loadCards(); }, 5000);
}
`;
