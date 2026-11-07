/**
 * What an agent does on the person's own machine, and what it is told about it (INV-438, INV-1700).
 *
 * The native-environment box has two locks. The box daemon runs every command under the OS sandbox
 * (src/boxd/confinement.ts): writes outside the granted directories cannot happen. And the host
 * asks the person before every write it can see coming — a file written or edited, a shell command
 * that is not plainly a look — because on someone's own machine "inside the granted directory" is
 * still their files. Before this, the second lock was a classification the auto-reviewer recorded
 * in shadow mode and nobody acted on.
 *
 * The read-only test is the approval card's (shell-readonly.ts), which fails closed: a command is a
 * look only when every part of it is a known reader with no redirection, substitution or flag that
 * writes. Anything else asks. An operator's allow rule (`tool: bash`, `command: npm test`, `path: ~/proj`) lifts the
 * ask for routine work; it cannot lift the sandbox.
 */

import type { BundleStore, Repository } from "./bundles.ts";
import { classifyShell } from "./shell-readonly.ts";
import { isComputerWrite } from "../cua/execution.ts";

/** Tools that change the machine they run on; `computer` where a node opened the machine's own screen (INV-1707). */
export const HOST_WRITES: ReadonlySet<string> = new Set(["bash", "write_file", "edit_file", "browser_act", "browser_upload", "browser_fill_secret", "computer"]);

/** Why this call writes on the person's machine and asks first, or undefined when it only looks. */
export function hostBoxWrite(tool: string, input: Record<string, unknown>): string | undefined {
  if (!HOST_WRITES.has(tool)) return undefined;
  if (tool === "bash") {
    const shell = classifyShell(String(input.command ?? ""));
    return shell.readOnly ? undefined : `a shell command on the person's own machine that is not known to only read (${shell.because})`;
  }
  if (tool === "write_file" || tool === "edit_file") return `writes ${String(input.path ?? "a file")} on the person's own machine`;
  if (tool === "computer") {
    // A look at the screen does not ask; a click, a key or typing does, and the card says what it would send.
    const writes = Array.isArray(input.actions) ? (input.actions as { action?: unknown }[]).filter(action => isComputerWrite(action)) : [];
    return writes.length === 0 ? undefined : `input on the machine's own screen: ${writes.map(describeInput).join(", ")}`;
  }
  return "acts on the person's own machine";
}

/** One screen input as the approval card names it: what it does and where, never more than a line. */
function describeInput(action: { action?: unknown; coordinate?: unknown; text?: unknown; key?: unknown }): string {
  const at = Array.isArray(action.coordinate) ? ` at (${action.coordinate.join(", ")})` : "";
  if (action.action === "type") return `type "${String(action.text ?? "").slice(0, 80)}"`;
  if (action.action === "key") return `press ${String(action.key ?? "")}`;
  return `${String(action.action)}${at}`;
}

/** What `agentbox host up` promises, and what the daemon and the gate do. */
export const HOST_BOX_PROMISE =
  "Every command runs under the OS sandbox: writes only inside the rw roots, the work directory and the temp directories, credential directories unreadable, network only through the egress relay; where the sandbox is unavailable nothing runs. Files outside the roots are refused by the daemon, and every write asks you first.";

/** What the agent is told where a node opened the machine's own screen (INV-1707). */
export const HOST_BOX_SCREEN =
  "with the machine's own Mac screen as your desktop: the computer tool sees and drives it, one agent at a time, and every click, key or text you send asks the person first. It is macOS: shortcuts use cmd, not ctrl. There is no browser tool here; drive the apps on the screen";

/** What the agent on a host box is told, in its bundle's instructions. */
export const HOST_BOX_INSTRUCTION =
  "Your shell runs under the OS sandbox: a write outside those directories is refused by the operating system, not by a rule you can argue with. Every write here asks the person first; say what you are about to change before you change it.";

/**
 * Records what a native-environment box may reach as the bundle attached to it (`host-<name>`):
 * the record of truth the prompt and the audit read, beside the daemon's own copy of the roots.
 * `whose` is the sentence about the machine: the person's own (`host up`), or an organisation's
 * node (INV-1697).
 */
export function recordHostBoxBundle(bundles: BundleStore, box: string, repositories: readonly Repository[], whose: string, screen = false): void {
  const file = { bundles: bundles.list(), ...bundles.attachments() };
  const id = `host-${box}`;
  const roots = repositories.map(r => `${r.path} (${r.mode})`).join(", ");
  file.bundles = [...file.bundles.filter(b => b.id !== id), { id, name: `Host box ${box}`, secretIds: [], repositories: repositories.map(r => ({ ...r })), instructions: `You are on ${box}, ${whose}, ${screen ? HOST_BOX_SCREEN : "with no desktop"}. You may read and write only under: ${roots}. ${HOST_BOX_INSTRUCTION}` }];
  file.boxes = { ...file.boxes, [box]: [...new Set([...(file.boxes[box] ?? []), id])] };
  bundles.save(file);
}
