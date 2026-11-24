export const CHANNEL_SETUP_JS = String.raw`
function channelCallbackHint(node, template, type, id) {
  node.hidden = type !== "feishu";
  var slug = id.trim() || "CHANNEL_ID";
  node.textContent = template
    ? "{{ui.channels.callback}}" + " " + template.replace(/\/CHANNEL_ID\/callback$/, "/" + (/^[a-z][a-z0-9-]{0,31}$/.test(slug) ? slug : "CHANNEL_ID") + "/callback")
    : "{{ui.channels.callback-missing}}";
}
`;
