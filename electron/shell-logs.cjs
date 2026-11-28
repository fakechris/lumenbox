const fs = require("node:fs");
const path = require("node:path");

/**
 * Where the shell writes server.log, supervision.log, memguard.log and node.log: the place
 * Console.app looks, ~/Library/Logs/LumenBox — or LUMENBOX_LOGS_DIR when it is set. The override
 * exists for an app that is not the person's own: the release acceptance run starts several
 * beside the owner's installation, and with the real HOME each one appended its server output to
 * the owner's server.log and could rotate the owner's server.log.1 away (INV-2307). The one place
 * the shell decides it.
 */
function logsDir(env, home) {
  const named = env.LUMENBOX_LOGS_DIR;
  return named !== undefined && named !== "" ? named : path.join(home, "Library", "Logs", "LumenBox");
}

/**
 * The server's output, on disk. A Finder-launched app has no terminal, so until this existed
 * the server's log went nowhere — and the first real incident ("the box is unavailable", "my
 * message got no reply") had nothing to read. `<dir>/server.log`, rotated at 5 MB to one .1
 * copy; Console.app finds it, and so does `tail -f`.
 *
 * Each line stamped when it is written: the first real read of this log (2026-09-13) had
 * "socket lost" and "heard nothing for 2h" with no way to tell whether that was ten minutes or a
 * day ago. A chunk may end mid-line, so the stamp goes on the next line start, not on every chunk.
 */
function serverLog(dir) {
  const file = path.join(dir, "server.log");
  let atLineStart = true;
  return text => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
      } catch {}
      const stamp = `${new Date().toISOString()} `;
      let out = "";
      for (const piece of text.split(/(\n)/)) {
        if (piece === "") continue;
        if (piece === "\n") {
          out += piece;
          atLineStart = true;
          continue;
        }
        out += (atLineStart ? stamp : "") + piece;
        atLineStart = false;
      }
      fs.appendFileSync(file, out);
    } catch {}
  };
}

module.exports = { logsDir, serverLog };
