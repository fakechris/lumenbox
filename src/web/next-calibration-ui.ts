/**
 * Calibration on Settings → Supervision (INV-1773): how far each of the product's judges agrees
 * with a person, and the sheet a person gives that agreement with.
 *
 * Two parts. First, per judge and question, what a person's labels say of it — labels, kappa, how
 * much of what the person called a failure it caught, how much of what they called fine it would
 * have stopped — and what that lets it decide: nothing changes until it is measured; measured under
 * 0.6 its verdict is a hint and a person decides; under 0.8 it may not let anything through on its
 * own where nobody watches. Second, the latest verdicts nobody has labelled, each as the judge's own
 * question about what it read, with yes and no — and without the judge's answer, which a person
 * shown it would agree with. What the sheet may show is judge-sheet.ts's to say.
 *
 * Drawn under the supervision settings by wrapping `renderSupervisionPane`
 * (next-set-supervision-ui.ts), as reminders are drawn under the routines, so that page's script
 * stays its own. Reading and labelling are an admin's; the routes are calibration-routes.ts.
 */
export const NEXT_CALIBRATION_JS = `
var calib = { data: null, reading: false, error: "" };

function loadCalibration() {
  if (calib.reading) return;
  calib.reading = true;
  getJson("/api/calibration").then(function (got) { calib.data = got; calib.error = ""; }, function (error) { calib.data = null; calib.error = error.message; })
    .then(function () { calib.reading = false; if (next.view === "settings" && settings.pane === "supervision") render(); });
}

function calibNumber(value) { return value === undefined || value === null ? "—" : (Math.abs(value) < 0.005 ? 0 : value).toFixed(2); }
function calibShare(value) { return value === undefined || value === null ? "—" : Math.round(value * 100) + "%"; }

/** What a judge's question may decide, in words, and whether that is a warning. */
function calibStanding(one) {
  if (!one.measured) return { text: t("ui.next.cal.notCalibrated"), cls: "note" };
  if (!one.mayGate) return { text: t("ui.next.cal.hint"), cls: "bad" };
  if (!one.mayReleaseUnattended) return { text: t("ui.next.cal.gateAttended"), cls: "warn" };
  return { text: t("ui.next.cal.gate"), cls: "" };
}

function calibStandings() {
  var box = el("section", "setting"), data = calib.data;
  box.appendChild(el("h2", "group", t("ui.next.cal.title")));
  box.appendChild(el("p", "note", t("ui.next.cal.about")));
  if (data.problem) box.appendChild(el("p", "note bad", t("ui.next.cal.problem", { problem: data.problem })));
  (data.judges || []).forEach(function (judge) {
    box.appendChild(el("h3", "", t("ui.next.cal.judge." + judge.judge)));
    var model = (judge.versions || [])[0];
    box.appendChild(el("p", "note", (model ? t("ui.next.cal.model", { model: model.judgeModel, version: model.judgeVersion }) + " · " : "") +
      t("ui.next.cal.counts", { verdicts: judge.verdicts, matched: judge.matched })));
    judge.questions.forEach(function (one) {
      var row = el("div", "fact"), left = el("div", "calib-left"), standing = calibStanding(one);
      row.classList.add("calib-row"); row.dataset.question = one.question;
      left.appendChild(el("b", "", t("ui.next.cal.q." + one.question)));
      if (one.dimension === "satisfaction") left.appendChild(el("span", "warn", " · " + t("ui.next.cal.satisfaction")));
      left.appendChild(el("div", standing.cls || "note", standing.text));
      left.appendChild(el("div", "note", t("ui.next.cal.numbers", { labels: one.labels, kappa: calibNumber(one.kappa), caught: calibShare(one.catchRate), killed: calibShare(one.falseKillRate) })));
      row.appendChild(left);
      box.appendChild(row);
    });
  });
  return box;
}

function calibSheet() {
  var box = el("section", "setting"), sheet = (calib.data && calib.data.sheet) || { items: [], unshown: 0 };
  box.appendChild(el("h2", "group", t("ui.next.cal.sheet")));
  box.appendChild(el("p", "note", t("ui.next.cal.sheetAbout", { n: calib.data.labels || 0 })));
  if (sheet.items.length === 0) box.appendChild(el("p", "note", t("ui.next.cal.nothing")));
  sheet.items.forEach(function (item) {
    var one = el("div", "calib-item");
    one.appendChild(el("b", "", t("ui.next.cal.q." + item.question)));
    one.appendChild(el("p", "note", item.agent + " · " + new Date(item.at).toLocaleString()));
    item.parts.forEach(function (part) {
      one.appendChild(el("div", "note", t("ui.next.cal.part." + part.key)));
      one.appendChild(el("pre", "raw", part.text));
    });
    var acts = el("div", "acts"), yes = el("button", "act", t("ui.next.cal.yes")), no = el("button", "act", t("ui.next.cal.no"));
    var send = function (label) {
      yes.disabled = true; no.disabled = true;
      postJson("/api/calibration/label", { question: item.question, digest: item.digest, label: label }).then(function () {
        toast(t("ui.next.cal.saved")); calib.data = null; loadCalibration();
      }, function (error) { yes.disabled = false; no.disabled = false; failed(error); });
    };
    yes.addEventListener("click", function () { send("present"); });
    no.addEventListener("click", function () { send("absent"); });
    acts.appendChild(yes); acts.appendChild(no); one.appendChild(acts);
    box.appendChild(one);
  });
  if (sheet.unshown > 0) box.appendChild(el("p", "note", t("ui.next.cal.unshown", { n: sheet.unshown })));
  box.appendChild(el("p", "note", t("ui.next.cal.shows")));
  return box;
}

function renderCalibration(view) {
  if (!(settings.me && settings.me.role === "admin")) return;
  if (calib.data === null) {
    if (calib.error) view.appendChild(el("p", "note bad", calib.error));
    else { view.appendChild(el("p", "empty", t("ui.next.auto.reading"))); loadCalibration(); }
    return;
  }
  view.appendChild(calibStandings()); view.appendChild(calibSheet());
}

var renderSupervisionSettings = renderSupervisionPane;
renderSupervisionPane = function (view) { renderSupervisionSettings(view); renderCalibration(view); };
// The settings table took the function itself when it was built: it is pointed at the wrapped one too.
NATIVE_PANES.supervision = renderSupervisionPane;
`;
