export const PERSONAL_BOX_DIALOG_JS = `
function personalComputerRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), function (byte) {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

function computerElement(tag, text, className) {
  var node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function computerDialog(title, build) {
  var dialog = computerElement("dialog"), body = computerElement("div"), heading = computerElement("h2", title);
  dialog.setAttribute("aria-label", title);
  dialog.style.cssText = "width:min(460px,calc(100vw - 32px));padding:20px;border:1px solid var(--border);border-radius:12px;color:var(--text);background:var(--surface,var(--bg))";
  heading.style.cssText = "font-size:18px;margin:0 0 12px";
  body.style.cssText = "display:grid;gap:10px";
  dialog.appendChild(heading); dialog.appendChild(body);
  var actions = computerElement("div"), cancel = computerElement("button", t("ui.personal.cancel"));
  cancel.classList.add("act", "btn", "sm");
  actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end";
  cancel.addEventListener("click", function () { dialog.close(); });
  dialog.addEventListener("close", function () { dialog.remove(); });
  function action(label, dangerous, run) {
    var button = computerElement("button", label);
    button.classList.add(dangerous ? "act-danger" : "act", "btn", "sm");
    if (dangerous) button.style.color = "var(--danger,var(--bad))";
    button.addEventListener("click", function () { run(function () { dialog.close(); }); });
    actions.appendChild(button);
    return button;
  }
  actions.appendChild(cancel);
  build(body, action);
  body.appendChild(actions); document.body.appendChild(dialog);
  dialog.showModal();
}

function computerLoss(boxes) {
  var agents = boxes.reduce(function (all, box) { return all.concat(box.agents || []); }, []);
  return t("ui.personal.loss", { agents: agents.length ? agents.join(", ") : t("ui.personal.noAgents") });
}

function deleteComputerDialog(box, erase) {
  var agentIds = (box.agentIds || []).slice();
  computerDialog(t("ui.personal.deleteTitle", { name: box.name }), function (body, action) {
    body.appendChild(computerElement("p", computerLoss([box])));
    action(t("ui.personal.delete"), true, function (close) { close(); erase(agentIds); });
  });
}

function computerRecipients(select, people, excluded) {
  var blank = computerElement("option", t("ui.personal.selectRecipient"));
  blank.value = ""; select.appendChild(blank);
  people.filter(function (person) { return person.eligible && person.id !== excluded; }).forEach(function (person) {
    var option = computerElement("option", person.name + " · " + computerQuota(person));
    option.value = person.id; select.appendChild(option);
  });
}

function computerQuota(person) {
  return t("ui.personal.quota", { held: person.held, quota: person.quota === null ? t("ui.personal.unlimited") : person.quota });
}

function removeMemberComputerDialog(person, inventory, remove) {
  var owned = inventory.boxes.filter(function (box) { return box.owner === person.id && !box.orphaned; });
  if (!owned.length) { remove(null); return; }
  var boxIds = owned.map(function (box) { return box.id; });
  var agentIds = owned.flatMap(function (box) { return box.agentIds || []; });
  computerDialog(t("ui.personal.removeMember", { name: person.name }), function (body, action) {
    body.appendChild(computerElement("p", t("ui.personal.choose", { names: owned.map(function (box) { return box.name; }).join(", ") })));
    var choice = computerElement("select"), recipient = computerElement("select"), note = computerElement("p");
    choice.setAttribute("aria-label", t("ui.personal.disposition")); recipient.setAttribute("aria-label", t("ui.personal.selectRecipient"));
    [["", t("ui.personal.disposition")], ["keep", t("ui.personal.keep")], ["transfer", t("ui.personal.transfer")], ["delete", t("ui.personal.delete")]].forEach(function (pair) {
      var option = computerElement("option", pair[1]); option.value = pair[0]; choice.appendChild(option);
    });
    computerRecipients(recipient, inventory.people, person.id);
    body.appendChild(choice); body.appendChild(recipient); body.appendChild(note);
    function submit(close) {
      if (!choice.value || (choice.value === "transfer" && !recipient.value)) return;
      close(); remove({ action: choice.value, recipient: recipient.value, boxIds: boxIds, agentIds: agentIds });
    }
    var apply = action(t("ui.personal.remove"), false, submit), erase = action(t("ui.personal.removeDelete"), true, submit);
    function show() {
      var deleting = choice.value === "delete";
      recipient.hidden = choice.value !== "transfer"; apply.hidden = deleting; erase.hidden = !deleting;
      apply.disabled = !choice.value || (choice.value === "transfer" && !recipient.value);
      note.textContent = deleting ? computerLoss(owned) : choice.value === "keep" ? t("ui.personal.keepNote") : "";
    }
    choice.addEventListener("change", show); recipient.addEventListener("change", show); show();
  });
}
`;
