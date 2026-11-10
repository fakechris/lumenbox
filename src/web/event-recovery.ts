/** Browser transport state, shared by the served page and deterministic recovery tests. */
export const EVENT_RECOVERY_JS = String.raw`
function createEventRecovery(options) {
  var epoch = "", seq = -1, loading = false, dirty = false, generation = 0, disconnected = false;
  var schedule = options.schedule || function (fn, delay) { setTimeout(fn, delay); };
  function state(value) { if (options.connection) options.connection(value); }
  function cursor(raw) {
    var match = /^(.*):(\d+)$/.exec(raw.lastEventId || "");
    return match && Number.isSafeInteger(Number(match[2])) ? { epoch: match[1], seq: Number(match[2]) } : null;
  }
  function rebuild() {
    var version = generation;
    dirty = false;
    Promise.resolve().then(options.rebuild).then(function () {
      if (version !== generation || dirty) { schedule(rebuild, 250); return; }
      loading = false; state(disconnected ? "reconnecting" : "connected");
    }, function () { state(disconnected ? "reconnecting" : "syncing"); schedule(rebuild, 1000); });
  }
  function reset(next) {
    if (next) { epoch = next.epoch; seq = next.seq; }
    generation++; dirty = true; state("syncing");
    if (!loading) { loading = true; rebuild(); }
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
    // No result bodies are queued during reset. Re-read until a whole snapshot read has no intervening events.
    if (loading) { dirty = true; return; }
    options.apply(raw);
  }
  return {
    receive: receive,
    checkpoint: function (raw) {
      var next = cursor(raw);
      if (!next) return;
      if (epoch && epoch !== next.epoch) { reset(next); return; }
      epoch = next.epoch; seq = Math.max(seq, next.seq);
    },
    opened: function () { disconnected = false; state(loading ? "syncing" : "connected"); },
    failed: function () { disconnected = true; state("reconnecting"); }
  };
}

function rebuildEventViews() {
  var id = current, conversation = currentConversation, chat = $("chat"), board = $("tasklist");
  var top = chat.scrollTop, follow = nearBottom(chat), boardTop = board.scrollTop;
  busy.clear();
  return refresh().then(function () {
    var reads = [refreshTasks()];
    if (id && current === id && currentConversation === conversation && agentById(id)) {
      reads.push(select(id, conversation).then(function () {
        if (current === id && currentConversation === conversation && !follow) chat.scrollTop = top;
      }));
    }
    $("feed").textContent = ""; reads.push(loadActivity());
    if (window.refreshTaskExecution) reads.push(window.refreshTaskExecution());
    return Promise.all(reads).then(function () { board.scrollTop = boardTop; });
  });
}

function installEventRecovery(stream) {
  var wasDisconnected = false;
  var recovery = createEventRecovery({ apply: stream.onmessage, rebuild: rebuildEventViews,
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
