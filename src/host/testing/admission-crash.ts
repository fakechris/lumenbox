/** Subprocess failpoints: only test code terminates the process, never the runtime. */
import { join } from "node:path";
import { AgentRegistry } from "../../agents/registry.ts";
import { Inbox } from "../../agents/inbox.ts";
import type { InboundMessage } from "../../agents/bus.ts";
import { Orchestrator } from "../orchestrator.ts";
import { TurnLedger } from "../resume.ts";
import { fakeModel } from "./fake-model.ts";

const [root, point] = process.argv.slice(2);
if (root === undefined || point === undefined) throw new Error("root and failpoint required");
process.env.AGENTBOX_HOME = root;
const crash = (): never => { process.kill(process.pid, "SIGKILL"); throw new Error("SIGKILL failed"); };
const registry = new AgentRegistry(join(root, "agents"));
const agent = registry.create({ name: "Ada", boxId: registry.box.id });
class CrashInbox extends Inbox<InboundMessage> {
  override start(seqs: readonly (number | undefined)[]): void {
    if (seqs.length > 0 && point === "begin-before-start") crash();
    super.start(seqs);
  }
}
const orch = new Orchestrator({
  registry, useBox: false, inbox: new CrashInbox(join(root, "inbox.jsonl")),
  turns: new TurnLedger(join(root, "turns.jsonl")),
  mcp: null, hooks: null, tasks: null, extensions: null, pendingWork: null,
  client: fakeModel(() => crash()),
});
if (point === "setup") orch.skills.refresh = async () => crash();
await orch.prompt(agent.id, "hello", { userId: "alice" }, { messageId: "crash-request" });
throw new Error("failpoint not reached");
