// The Seatbelt profile a confined command really runs under, printed for `measure.sh` (INV-1756):
// the measurement tests the profile the daemon builds, not a copy of it written by hand.
//
//   node --experimental-transform-types scripts/screen-wall/profile.ts <work-dir> <egress-port> open|closed profile|env

import { confinementFor } from "../../src/boxd/confinement.ts";
import { Roots } from "../../src/boxd/headless.ts";

const [work, port, screen, what] = process.argv.slice(2);
if (work === undefined || port === undefined || (screen !== "open" && screen !== "closed") || (what !== "profile" && what !== "env")) {
  process.stderr.write("usage: profile.ts <work-dir> <egress-port> open|closed profile|env\n");
  process.exit(64);
}
const confine = confinementFor({ headless: true, screenOpen: screen === "open", roots: () => new Roots([{ path: work, mode: "rw" }]), workDir: work, egressPort: () => Number(port), log: () => {} });
if (confine === undefined) throw new Error("a headless box is always confined");
const wrapped = confine.wrap("/usr/bin/true", [], { what: "exec", actor: "agent:measure" });
if (wrapped.command !== "/usr/bin/sandbox-exec" || wrapped.args[0] !== "-p" || wrapped.args[1] === undefined) throw new Error(`not a Seatbelt profile: ${wrapped.command}`);
// The state directories an agent's tools are pointed at, as lines a shell can read.
const env = Object.entries(wrapped.env).map(([name, value]) => `export ${name}='${value.replace(/'/g, "'\\''")}'`);
process.stdout.write(what === "profile" ? wrapped.args[1] : `${env.join("\n")}\n`);
