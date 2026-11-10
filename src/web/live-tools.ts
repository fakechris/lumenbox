/** The live and replay paths keep the same call identity (INV-1784). No agent-wide pending slot. */
export const LIVE_TOOLS_JS = String.raw`/* Live tool calls */
var openCall = new Map();
var liveReplay = null;
function liveCallKey(e) {
  return e.turnId && e.toolUseId ? JSON.stringify([e.agentId, e.conversation || "main", e.turnId, e.toolUseId]) : null;
}
function rememberLiveCall(e, work, call) {
  var key = liveCallKey(e);
  if (key) openCall.set(key, { work: work, call: call, settled: call.result !== undefined });
}
function beginLiveReplay() {
  var replay = { events: [] };
  liveReplay = replay;
  return replay;
}
function finishLiveReplay(replay) {
  if (liveReplay !== replay) return;
  liveReplay = null;
  replay.events.forEach(handleLiveTool);
}
function handleLiveTool(e) {
  if (e.type !== "tool_start" && e.type !== "tool_end") return false;
  if (!inView(e)) return true;
  if (liveReplay) { liveReplay.events.push(e); return true; }
  var key = liveCallKey(e), pending = key && openCall.get(key);
  if (e.type === "tool_start") {
    if (pending) return true;
    if (openAgent) { openAgent.streaming = false; openAgent.queued = false; redrawItem(openAgent); openAgent = null; }
    if (!openWork) openWork = pushItem({ kind: "work", calls: [], startAt: new Date().toISOString(), done: false });
    var call = { name: e.tool, detail: toolDetail(e.tool, e.input), result: key ? undefined : "{{ui.app.live-result-unavailable}}", isError: false, diff: e.diff || null, turnId: e.turnId, toolUseId: e.toolUseId };
    openWork.calls.push(call);
    rememberLiveCall(e, openWork, call);
    redrawItem(openWork);
  } else if (pending && !pending.settled) {
    pending.settled = true;
    pending.call.result = e.summary || "";
    pending.call.isError = e.isError === true;
    pending.call.gate = e.gate || null;
    if (e.screenshot) pending.call.shot = e.screenshot;
    redrawItem(pending.work);
  }
  // Old producers without call ids are read from durable history, never guessed into another row.
  return true;
}
/* End live tool calls */`;
