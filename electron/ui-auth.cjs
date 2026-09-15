const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** One credential for the child hostd, the shell event stream and the initial UI cookie. */
function desktopAuth(env = process.env) {
  let token = env.AGENTBOX_UI_TOKEN;
  if (token !== undefined && !token.trim()) throw new Error("The configured LumenBox UI token is empty.");
  if (!token) {
    const file = env.LUMENBOX_UI_TOKEN_FILE || path.join(env.AGENTBOX_HOME || path.join(os.homedir(), ".agentbox"), "ui-token");
    if (env.LUMENBOX_UI_TOKEN_FILE || fs.existsSync(file)) {
      try { token = fs.readFileSync(file, "utf8").trim(); }
      catch { throw new Error("The configured LumenBox UI token file cannot be read."); }
      if (!token) throw new Error("The configured LumenBox UI token file is empty.");
    }
  }
  if (token && /[\r\n]/.test(token)) throw new Error("The LumenBox UI token must be a single line.");
  return {
    token,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    bootstrapUrl: base => token ? `${base}?token=${encodeURIComponent(token)}` : base,
  };
}

module.exports = { desktopAuth };
