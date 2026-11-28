/**
 * The one line under a row's name or title (INV-1926).
 *
 * A member row said "Working" or the member's job title; a work row said a sentence from a fixed
 * table — a category, in words like "linked execution", not what this member is doing about this
 * work. The line is now chosen in one order for both rows:
 *
 *   1. what the member asks of the person: the title of the card it owes (person-ask.ts, the same
 *      reading the card above the conversation shows — nothing is parsed again here);
 *   2. what the member says it is doing now, in its own words (member-now.ts), while a turn is running
 *      and the words are fresh;
 *   3. the fixed words, said plainly and saying where the work is stuck (`ui.next.line.*`).
 *
 * One line per row and nothing added beside it: the line is cut to fit by its style, and the whole of
 * it is on hover and in what the row opens.
 */
import { NOW_FRESH_MS } from "./member-now.ts";

export const NEXT_LINE_JS = `
var NOW_FRESH_MS = ${NOW_FRESH_MS};

/** Whether a row still asks something of the person: a result to look at or a request nobody has answered, not put off. */
function waitsOnPerson(row) { return !!nextNeedOf(row) && !putOff(row) && !(row.receipt && row.status === "blocked"); }

/** What a member asks of the person, in one line: the title of the card it owes, else the fixed words for that card. */
function askLine(row) {
  if (row.ask) return row.ask.title;
  if (nextNeedOf(row) === "delivery") return t("ui.next.line.reason.review");
  var last = (row.history || [])[(row.history || []).length - 1] || {};
  return last.note ? String(last.note).split("\\n")[0] : t("ui.next.line.answer");
}

/** What a member says it is doing, while that can still be true: its turn is running and it said so in the last minutes. */
function nowLine(agent) {
  var now = agent && agent.facts && agent.facts.now;
  return now && Date.now() - Date.parse(now.at) <= NOW_FRESH_MS ? now : null;
}

/** A member row's line: what it asks of the person, else what it says it is doing, else what it is. */
function memberLine(agent) {
  var owed = next.rows.filter(function (row) { return row.assigneeId === agent.id && waitsOnPerson(row); })
    .sort(function (a, b) { return String(a.updatedAt).localeCompare(String(b.updatedAt)); })[0];
  if (owed) return askLine(owed);
  var awaiting = agent.facts && agent.facts.awaiting;
  if (awaiting && awaiting.kind === "question" && awaiting.reason) return awaiting.reason;
  if (awaiting) return t(MSG["ui.next.line.await." + awaiting.kind] ? "ui.next.line.await." + awaiting.kind : "ui.next.line.await.other");
  var now = nowLine(agent);
  if (now) return now.text;
  return agent.running ? t("ui.next.agent.working") : roleOf(agent);
}

/** An agent's role as a person reads it: a role the starter team ships with is a word in the tables; one a person wrote is theirs, as written. */
function roleOf(agent) {
  if (!agent) return "";
  var key = "ui.role." + String(agent.title || "").toLowerCase();
  return MSG[key] !== undefined ? t(key) : (agent.title || agent.description || "");
}

/** The member's line on the work it is about: the work its running turn is on, else the one piece it is doing in that conversation. */
function nowOnRow(row) {
  var now = nowLine(next.agents[row.assigneeId]);
  if (!now || row.status !== "doing") return "";
  if (now.taskId) return now.taskId === row.id ? now.text : "";
  var doing = next.rows.filter(function (other) { return other.assigneeId === row.assigneeId && other.status === "doing" && (other.conversation || "main") === now.conversation; });
  return doing.length === 1 && doing[0].id === row.id ? now.text : "";
}

/** The sentence under a work row's title: what the person is asked, else what the member says it is doing, else where the work stands. */
function reasonOf(row) {
  // What the agent itself asks of the person comes before any sentence from the table (INV-1923).
  if (row.ask && !putOff(row)) return row.ask.title;
  var owed = next.mine.filter(function (item) { return item.ref === row.id; })[0];
  if (owed && owedText(owed)) return owedText(owed);
  var said = nowOnRow(row);
  if (said) return said;
  // What a job is waiting on outside the agent — credentials it lacks, most often — is the reason, in the board's words.
  if (row.waitingOn) return row.waitingOn;
  var reading = row.reading || {};
  if (reading.blocker && MSG["ui.next.line.blocker." + reading.blocker.kind]) {
    var tools = (reading.blocker.tools || []).join(", ");
    return t("ui.next.line.blocker." + reading.blocker.kind) + (tools ? " (" + tools + ")" : "");
  }
  // Finished work needs no sentence: the word says it, and the panel has the result.
  var state = nextStateOf(row).key;
  if (state === "done" || state === "stopped") return "";
  return MSG["ui.next.line.reason." + reading.reason] ? t("ui.next.line.reason." + reading.reason) : "";
}

/** A row's line: one line, cut to fit by its style, and the whole of it on hover. */
function lineNode(cls, text) { var node = el("div", cls, text); if (text) node.title = text; return node; }
`;
