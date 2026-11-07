/**
 * Where an organisation's session token is kept on this computer (INV-1690, docs/95 §4): the
 * operating system's keychain, behind three calls so the connection store can be tested with a
 * double and never touch a real one.
 *
 * macOS only for now, through `/usr/bin/security`. The secret goes in on the tool's stdin (its
 * interactive mode), never on its argument list, where any process could read it with `ps`; it
 * is stored base64url so no character of it needs quoting there. Nothing here logs a secret: a
 * failure says which call failed and the tool's exit code, not what it was given.
 */
const { execFile } = require("node:child_process");

/** The keychain service an organisation token is filed under; one item per connection id. */
const KEYCHAIN_SERVICE = "LumenBox organisation";
/** What `security` exits with when the item is not there. */
const NOT_FOUND = 44;

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/security", args, { timeout: 15_000 }, (error, stdout) => {
      if (error) {
        const failure = new Error(`keychain: security ${args[0]} failed (exit ${error.code ?? "?"})`);
        failure.exitCode = error.code;
        reject(failure);
        return;
      }
      resolve(String(stdout));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function checked(account) {
  if (typeof account !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(account)) throw new Error("keychain: an account is a connection id");
  return account;
}

/**
 * The macOS keychain under one service name (a test passes a unique one and deletes what it made).
 * `keychainFile`, for a rehearsal only, names a throwaway keychain file so nothing touches the
 * person's login keychain; the app never passes it.
 */
function macKeychain(service = KEYCHAIN_SERVICE, keychainFile) {
  if (!/^[A-Za-z0-9 ._-]{1,80}$/.test(service)) throw new Error("keychain: a service name is letters, digits, spaces and . _ -");
  if (keychainFile !== undefined && !/^\/[A-Za-z0-9._/-]+$/.test(keychainFile)) throw new Error("keychain: a keychain file is an absolute path of letters, digits and . _ - /");
  const quoted = `"${service}"`;
  const inFile = keychainFile === undefined ? [] : [keychainFile];
  return {
    async set(account, secret) {
      if (typeof secret !== "string" || secret === "") throw new Error("keychain: nothing to store");
      const encoded = Buffer.from(secret, "utf8").toString("base64url");
      await run(["-i"], `add-generic-password -U -s ${quoted} -a ${checked(account)} -w ${encoded}${inFile.length ? ` ${inFile[0]}` : ""}\n`);
      // Interactive mode answers 0 even when a command inside it failed: read it back.
      if ((await this.get(account)) !== secret) throw new Error("keychain: the token was not stored");
    },
    async get(account) {
      try {
        const out = await run(["find-generic-password", "-s", service, "-a", checked(account), "-w", ...inFile]);
        return Buffer.from(out.trim(), "base64url").toString("utf8");
      } catch (error) {
        if (error.exitCode === NOT_FOUND) return undefined;
        throw error;
      }
    },
    async remove(account) {
      try {
        await run(["delete-generic-password", "-s", service, "-a", checked(account), ...inFile]);
      } catch (error) {
        if (error.exitCode !== NOT_FOUND) throw error;
      }
    },
  };
}

/** The keychain this platform has, or one that refuses: an organisation token is not written anywhere else. */
function systemKeychain(platform = process.platform, service = KEYCHAIN_SERVICE) {
  if (platform === "darwin") return macKeychain(service);
  const refuse = async () => { throw new Error("keychain: joining an organisation needs the macOS keychain on this version"); };
  return { set: refuse, get: async () => undefined, remove: async () => {} };
}

/** A keychain in memory, for tests: the same three calls, and what it holds is inspectable. */
function memoryKeychain() {
  const items = new Map();
  return {
    items,
    async set(account, secret) { if (!secret) throw new Error("keychain: nothing to store"); items.set(checked(account), secret); },
    async get(account) { return items.get(checked(account)); },
    async remove(account) { items.delete(checked(account)); },
  };
}

module.exports = { KEYCHAIN_SERVICE, macKeychain, memoryKeychain, systemKeychain };
