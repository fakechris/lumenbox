/**
 * A person's phones, in Settings → Mine (INV-2214, docs/110 §4): connect one with a QR code the phone app
 * scans, see which are signed in, remove a lost one — it is signed out at once and wipes what it kept.
 * The QR code is shown only after a sign-in in the last ten minutes (recent-sign-in.ts); an older session is
 * told to sign in again, as minting a token is (INV-2318).
 */
export const NEXT_SET_PHONES_JS = `
var phones = { devices: null, failed: "", pairing: null, again: "", timer: 0 };
/** The platforms this page has a name for; one it does not know is shown as the server said it. */
var KNOWN_PLATFORMS = ["ios", "android", "macos", "windows", "linux"];

function loadPhones() {
  // A list that could not be read says so, with a way to ask again: never "no phone" when it does not know.
  getJson("/api/devices").then(function (got) { phones.devices = got.devices || []; phones.failed = ""; }, function (error) { phones.devices = []; phones.failed = error.message || String(error); })
    .then(function () { if (next.view === "settings") render(); });
}

/** What a refusal for an old sign-in says, and where to sign in again. */
function signInAgainNotice(words) {
  var notice = el("div", "needbox"), link = el("a", "", t("ui.next.mine.signInAgain"));
  notice.setAttribute("role", "status");
  notice.appendChild(el("p", "", words));
  link.href = "/login";
  notice.appendChild(link);
  return notice;
}

function phonesBlock() {
  if (phones.devices === null) { phones.devices = []; loadPhones(); }
  var box = el("section", "setting"), connect = el("button", "act", t("ui.next.mine.connectPhone")), row = el("div", "acts");
  box.appendChild(el("h2", "group", t("ui.next.mine.phones")));
  box.appendChild(el("p", "why", t("ui.next.mine.phonesNote")));
  if (phones.again) box.appendChild(signInAgainNotice(phones.again));
  if (phones.pairing) {
    // Shown for its two minutes, then taken away: the code in it works once and is stored nowhere it could be read back from.
    var shown = el("div", "needbox"), image = el("img", "pair-qr");
    image.src = "data:image/svg+xml;base64," + btoa(phones.pairing.qrSvg);
    image.alt = t("ui.next.mine.pairAlt");
    shown.appendChild(image);
    shown.appendChild(el("p", "", t("ui.next.mine.pairNote", { minutes: 2 })));
    box.appendChild(shown);
  }
  if (phones.failed) {
    var retry = el("button", "act", t("ui.next.mine.phonesRetry"));
    retry.addEventListener("click", loadPhones);
    box.appendChild(el("p", "why", t("ui.next.mine.phonesFailed", { error: phones.failed })));
    box.appendChild(retry);
  } else if (!phones.devices.length) box.appendChild(el("p", "empty", t("ui.next.mine.noPhones")));
  phones.devices.forEach(function (device) {
    var line = el("div", "fact"), remove = el("button", "act", t("ui.next.mine.removePhone"));
    var when = device.lastUsedAt ? " · " + t("ui.next.mine.lastUsed", { when: new Date(device.lastUsedAt).toLocaleDateString() }) : "";
    line.appendChild(el("span", "", device.name + " · " + (KNOWN_PLATFORMS.indexOf(device.platform) >= 0 ? t("ui.next.mine.platform." + device.platform) : device.platform) + when));
    remove.addEventListener("click", function () { postJson("/api/devices/remove", { id: device.id }).then(loadPhones, failed); });
    line.appendChild(remove); box.appendChild(line);
  });
  connect.addEventListener("click", function () {
    postJson("/api/devices/pairing", {}).then(function (got) {
      phones.pairing = got; phones.again = "";
      clearTimeout(phones.timer);
      phones.timer = setTimeout(function () { phones.pairing = null; loadPhones(); }, Math.max(0, Date.parse(got.expiresAt) - Date.now()));
      render();
    }, function (error) {
      if (!error.data || error.data.code !== "sign-in-again") { failed(error); return; }
      phones.again = error.message; phones.pairing = null; render();
    });
  });
  row.appendChild(connect); box.appendChild(row);
  return box;
}
`;
