/** Browser transport state, shared by the served page and deterministic recovery tests. */
export const EVENT_RECOVERY_JS = String.raw`
function createEventRecovery(options) {
  var epoch = "", seq = -1, loading = false, generation = 0, disconnected = false;
  var pending = [], bytes = 0, commitRead = false;
  var schedule = options.schedule || function (fn, delay) { setTimeout(fn, delay); };
  function state(value) { if (options.connection) options.connection(value); }
  function cursor(raw) {
    var match = /^(.*):(\d+)$/.exec(raw.lastEventId || "");
    return match && Number.isSafeInteger(Number(match[2])) ? { epoch: match[1], seq: Number(match[2]) } : null;
  }
  function rebuild() {
    var version = generation;
    Promise.resolve().then(options.rebuild).then(function (snapshot) {
      if (version !== generation) { schedule(rebuild, 0); return; }
      var queued = pending; pending = []; bytes = 0; loading = false;
      queued.forEach(function (raw) {
        var id = cursor(raw), feed = snapshot && snapshot.feedCursor;
        var bound = feed && cursor({ lastEventId: feed });
        if (id && bound && id.epoch === bound.epoch && id.seq <= bound.seq) raw.skipFeed = true;
        options.apply(raw);
      });
      if (commitRead && options.commitEvent && queued.some(function (raw) { return options.commitEvent(JSON.parse(raw.data)); })) { reset(null, false); return; }
      state(disconnected ? "reconnecting" : "connected");
    }, function () { state(disconnected ? "reconnecting" : "syncing"); schedule(rebuild, 1000); });
  }
  function reset(next, followCommit) {
    if (next) { epoch = next.epoch; seq = next.seq; pending = []; bytes = 0; }
    generation++; commitRead = followCommit !== false; state("syncing");
    if (!loading) { loading = true; rebuild(); }
  }
  function queue(raw) {
    var size = raw.data.length * 2;
    pending.push(raw); bytes += size;
    while (pending.length > 512 || bytes > 1024 * 1024) { bytes -= pending.shift().data.length * 2; commitRead = true; }
  }
  function receive(raw) {
    var event;
    try { event = JSON.parse(raw.data); } catch (error) { reset(null); return; }
    var next = cursor(raw);
    if (event.type === "reset") { reset(next); return; }
    if (next) {
      if (epoch && next.epoch !== epoch) { reset(next); return; }
      if (next.epoch === epoch && next.seq <= seq) return;
      epoch = next.epoch; seq = next.seq;
    }
    if (!loading && commitRead && options.commitEvent && options.commitEvent(event)) reset(null, false);
    if (loading) { queue(raw); return; }
    options.apply(raw);
  }
  return {
    receive: receive,
    checkpoint: function (raw) {
      var next = cursor(raw);
      if (!next) return;
      if (epoch && epoch !== next.epoch) { reset(next); return; }
      if (!epoch) commitRead = true; // Joining an already-streaming answer may precede its durable transcript append.
      epoch = next.epoch; seq = Math.max(seq, next.seq);
    },
    opened: function () { disconnected = false; state(loading ? "syncing" : "connected"); },
    failed: function () { disconnected = true; state("reconnecting"); }
  };
}

function captureEventReading(chat) {
  var top = chat.getBoundingClientRect().top;
  var candidates = Array.from(chat.querySelectorAll("[data-call-key], [data-m]"));
  var anchor = candidates.find(function (node) { var box = node.getBoundingClientRect(); return box.height > 0 && box.bottom > top; });
  return { follow: nearBottom(chat), key: anchor && (anchor.getAttribute("data-call-key") || "message:" + anchor.getAttribute("data-m")),
    at: anchor && anchor.getAttribute("data-at"), preview: anchor && (anchor.querySelector(".body") || anchor).textContent.slice(0, 80),
    offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
    calls: candidates.filter(function (node) { return node.hasAttribute("data-call-key"); }).map(function (node) {
      var work = node.closest("details.work");
      return { key: node.getAttribute("data-call-key"), open: node.open, work: work && work.open };
    }) };
}
function restoreEventReading(chat, saved) {
  var nodes = Array.from(chat.querySelectorAll("[data-call-key], [data-m]"));
  saved.calls.forEach(function (call) {
    var node = nodes.find(function (node) { return node.getAttribute("data-call-key") === call.key; });
    if (node) { node.open = call.open; var work = node.closest("details.work"); if (work) work.open = call.work; }
  });
  if (saved.follow || !saved.key) return;
  var node = nodes.find(function (node) {
    var key = node.getAttribute("data-call-key") || "message:" + node.getAttribute("data-m");
    return key === saved.key && (node.hasAttribute("data-call-key") || (node.getAttribute("data-at") === saved.at && (node.querySelector(".body") || node).textContent.slice(0, 80) === saved.preview));
  });
  if (node) chat.scrollTop += node.getBoundingClientRect().top - chat.getBoundingClientRect().top - saved.offset;
  else { chat.scrollTop = 0; feed("{{ui.app.stream-anchor-expired}}", ""); }
}
function rebuildEventViews() {
  var id = current, conversation = currentConversation, chat = $("chat"), board = $("tasklist");
  var reading = captureEventReading(chat), boardTop = board.scrollTop, feedCursor;
  busy.clear();
  return refresh().then(function () {
    var reads = [refreshTasks()];
    if (window.taskFocusVisible) window.taskConversationDirty = true;
    if (!window.taskFocusVisible && id && current === id && currentConversation === conversation && agentById(id)) reads.push(select(id, conversation));
    $("feed").textContent = "";
    reads.push(loadActivity().then(function (cursor) { feedCursor = cursor; }));
    if (window.refreshTaskExecution) reads.push(window.refreshTaskExecution());
    return Promise.all(reads).then(function () {
      if (current === id && currentConversation === conversation) restoreEventReading(chat, reading);
      board.scrollTop = boardTop; return { feedCursor: feedCursor };
    });
  });
}

function recoveryCommitFor(event, agent, conversation) {
  return event.agentId === agent && (event.conversation || "main") === conversation && (event.type === "tool_start" || event.type === "turn_finished");
}
function installEventRecovery(stream) {
  var wasDisconnected = false;
  var recovery = createEventRecovery({ apply: stream.onmessage, rebuild: rebuildEventViews,
    commitEvent: function (event) { return recoveryCommitFor(event, current, currentConversation); },
    connection: function (state) {
      document.documentElement.dataset.connection = state;
      window.dispatchEvent(new CustomEvent("lumen-connection", { detail: state }));
      if (state === "reconnecting" && !wasDisconnected) { wasDisconnected = true; feed("{{ui.app.stream-reconnecting}}", ""); }
      if (state === "connected" && wasDisconnected) { wasDisconnected = false; feed("{{ui.app.stream-restored}}", ""); }
    }
  });
  stream.onmessage = recovery.receive;
  stream.onopen = recovery.opened;
  stream.onerror = recovery.failed;
  stream.addEventListener("checkpoint", recovery.checkpoint);
  return recovery;
}
`;
