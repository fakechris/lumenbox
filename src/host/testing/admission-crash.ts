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
const agent = registry.list()[0] ?? registry.create({ name: "Ada", boxId: registry.box.id });
class CrashInbox extends Inbox<InboundMessage> {
  override start(seqs: readonly (number | undefined)[]): void {
    if (seqs.length > 0 && point === "begin-before-start") crash();
    if (seqs.includes(2) && point === "steering") crash();
    super.start(seqs);
  }
}
class CrashTurns extends TurnLedger {
  override end(id: string, how: string): void {
    if (point === "resume-before-close" && (how === "resumed" || how === "continued")) crash();
    super.end(id, how);
  }
}
const orch = new Orchestrator({
  registry, useBox: false, inbox: new CrashInbox(join(root, "inbox.jsonl")),
  turns: new CrashTurns(join(root, "turns.jsonl")),
  mcp: null, hooks: null, tasks: null, extensions: null, pendingWork: null,
  client: fakeModel(() => {
    if (point !== "steering") return crash();
    orch.bus.sendFromUser(agent.id, "STEERING_RECOVERY", { principalId: "alice", messageId: "steer-request" });
    return { id: "call", type: "message", role: "assistant", model: "test",
      content: [{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "/not-present" } }],
      stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 },
    } as never;
  }),
});
if (point === "setup" || point === "resume-setup") orch.skills.refresh = async () => crash();
if (point.startsWith("resume-")) {
  orch.bus.recover();
  orch.resumeInterrupted();
  await orch.settle();
  throw new Error("resume failpoint not reached");
}
await orch.prompt(agent.id, "hello", { userId: "alice" }, { messageId: "crash-request" });
throw new Error("failpoint not reached");
