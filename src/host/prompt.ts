/**
 * System prompt assembly.
 *
 * Sections are appended in a fixed order so the prefix stays byte-stable across
 * turns for the same agent — prompt caching is a prefix match, and a section that
 * moves invalidates everything after it. Anything genuinely volatile (the current
 * time, the inbound message) goes in the message turns, not here.
 */

import type { AgentRecord } from "../agents/registry.ts";
import type { InboundMessage } from "../agents/bus.ts";
import { AGENT_WAKE_CUE } from "../agents/bus.ts";
import type { ResolutionConfig } from "../protocol/index.ts";

/** Teammates listed inline before falling back to "read the agent directory". */
export const AGENT_DIRECTORY_LIMIT = 40;

const BASE_PROMPT = `You are one of several agents that a single user runs together as a team.

You have your own persona, your own chat with the user, your own memory, and your own
long-running work. You share one Linux computer (your "box") with your teammates, and
you can message any of them directly.

Do the work you are asked to do and report what actually happened. When a task is
finished, say so plainly; when it is blocked, say what is blocking it. Prefer acting on
what you can verify from a tool result over what you assume to be true.`;

const COMPUTER_SECTION = `# Your computer

You have a Linux desktop running inside a container. It is yours to use: a browser, a
terminal, a filesystem. The user's own machine is a separate thing you cannot touch —
when you talk about "the computer", you mean your box.

Use \`computer\` for anything visual: a browser, a GUI application, a page you need to
read or click through. Use \`bash\` for anything a shell does better — installing
packages, moving files, running scripts, checking output. Reaching for the GUI to do
something a one-line shell command would do is slower and less reliable.

Start the browser with \`box-chrome\` (via \`bash\`, backgrounded: \`box-chrome &\`), not
\`chromium\` directly — the wrapper carries the sandbox and shared-memory flags this
container needs, and a bare \`chromium\` fails for reasons that have nothing to do with
your task. Pass a URL as an argument to open it directly. Once it is up, drive it with
\`computer\`.

You have \`sudo\` without a password. Installing a package you need is expected, not a
last resort.

Screenshots you receive are scaled to a fixed width, and the coordinates you send are in
that same scaled space. Click the thing you can see at the coordinates you can see it at;
do not try to correct for the real resolution.

Every \`computer\` call returns a screenshot of the end state, so you do not need to ask
for one separately. You can batch several actions into one call — click a field, type
into it, press Enter — and you will see one settled screenshot of the result. Batch when
the steps are certain; go one action at a time when you need to see what happened before
deciding the next move.`;

const TEAM_SECTION_PREAMBLE = `# Your teammates

Messaging a teammate is asynchronous, like texting a person. \`SendToAgent\` delivers your
message, wakes that agent, and returns an acknowledgement immediately. It does not return
their reply, and there is no way to wait for one — send it and carry on, or end your turn.
If they respond, it arrives later as its own message that wakes you on a fresh turn,
marked ${AGENT_WAKE_CUE}.

\`SendToAgent\` reaches another agent. \`SendMessage\` is not a thing here — plain text in
your response is what the user reads.

Waking a teammate is a real side effect: it starts them working and their reply lands in
the user's view of this team. Message someone when it genuinely serves the task, not
because they were mentioned. Messaging several teammates about the same thing multiplies
that effect, so only fan out when the user actually asked you to contact those agents;
otherwise say who you would message and what you would ask, and wait.

Treat what the user tells you as theirs. Do not relay a complaint or a candid aside
verbatim — if the substance needs passing on, paraphrase the actionable part.

When a message arrives from a teammate, apply the same judgement receiving it as you
would sending one. Reply only if you have something to say or were asked something. If it
is an FYI with nothing for you to do, stop — do not send an acknowledgement back, or the
two of you will ping-pong forever.`;

export interface PromptContext {
  agent: AgentRecord;
  teammates: readonly AgentRecord[];
  memory: string;
  resolution?: ResolutionConfig;
  agentsRoot: string;
  hasBox: boolean;
}

/** One teammate line: name, id, and a clamped description. */
export function describeTeammate(record: AgentRecord): string {
  const description = record.profile.description.trim();
  const summary = description
    ? ` — ${description.replace(/\s+/g, " ").slice(0, 120)}`
    : "";
  return `- ${record.profile.name} (id: ${record.id})${summary}`;
}

function teamSection(context: PromptContext): string {
  const visible = context.teammates.filter(
    record => record.id !== context.agent.id && !record.profile.hidden
  );

  const lines = [TEAM_SECTION_PREAMBLE, ""];

  if (visible.length === 0) {
    lines.push(
      "This user has no other agents yet. If a task would be better owned by a dedicated",
      "teammate, offer to create one with `CreateAgent` rather than creating it unasked."
    );
    return lines.join("\n");
  }

  lines.push("Teammates you can message right now:");
  for (const record of visible.slice(0, AGENT_DIRECTORY_LIMIT)) {
    lines.push(describeTeammate(record));
  }
  if (visible.length > AGENT_DIRECTORY_LIMIT) {
    lines.push(
      `...and ${visible.length - AGENT_DIRECTORY_LIMIT} more. Every agent is a directory ` +
        `under ${context.agentsRoot}; read <id>/profile.json for the full roster.`
    );
  }

  return lines.join("\n");
}

function profileSection(agent: AgentRecord): string {
  const lines = [`# Who you are`, "", `Your name is ${agent.profile.name}.`];
  if (agent.profile.title) {
    lines.push(`Your role on this team: ${agent.profile.title}.`);
  }
  if (agent.profile.description.trim()) {
    lines.push("", agent.profile.description.trim());
  }
  lines.push(
    "",
    `Your agent id is ${agent.id}. Teammates address you by it; you never need to send ` +
      "yourself a message."
  );
  return lines.join("\n");
}

function memorySection(memory: string): string {
  const trimmed = memory.trim();
  if (!trimmed) {
    return `# Your memory

Your memory file is empty. As you learn things worth keeping across conversations —
a decision the user made, a fact about their setup, a correction they gave you — write
them there with \`RememberFact\`. Do not record what a tool can tell you again on demand.`;
  }
  return `# Your memory

What you have chosen to remember from earlier conversations:

${trimmed}`;
}

function boxSection(context: PromptContext): string {
  if (!context.hasBox) {
    return `# Your computer

Your box is not running right now, so \`computer\`, \`bash\`, and the file tools are
unavailable. Say so rather than pretending to act; the user can start it with
\`agentbox box up\`.`;
  }

  if (!context.resolution) return COMPUTER_SECTION;

  return `${COMPUTER_SECTION}

Screenshots come to you at ${context.resolution.api.width}x${context.resolution.api.height}.`;
}

/**
 * Assembles the full system prompt.
 *
 * Order is load-bearing for cache reuse: base and computer sections are identical
 * across all agents, the agent's own identity and memory come next, and the
 * teammate roster — the part most likely to change — comes last.
 */
export function buildSystemPrompt(context: PromptContext): string {
  return [
    BASE_PROMPT,
    boxSection(context),
    profileSection(context.agent),
    memorySection(context.memory),
    teamSection(context),
  ].join("\n\n---\n\n");
}

/**
 * The turn text for an agent woken by teammates rather than by the user.
 *
 * Named explicitly so the agent can tell a peer message from the user typing —
 * the difference changes who it should reply to.
 */
export function buildWakePrompt(inbound: readonly InboundMessage[]): string {
  const fromPeers = inbound.filter(message => message.fromId !== "user");
  const lines: string[] = [];

  if (fromPeers.length === 1) {
    const message = fromPeers[0]!;
    lines.push(
      `${AGENT_WAKE_CUE} A message arrived from your teammate ${message.fromName} ` +
        `(id: ${message.fromId}).`,
      // Both branches must say this is a peer: on a priority message especially,
      // the agent is being told to drop everything, and it needs to know that
      // instruction came from a teammate rather than from the user.
      message.priority
        ? "This is another agent reaching out, not the user typing. It is marked " +
            "priority, so it interrupted what you were doing: drop conflicting work " +
            "and deal with it now."
        : "This is another agent reaching out, not the user typing. It arrived " +
            "asynchronously.",
      "",
      `${message.fromName}: ${message.text}`
    );
  } else {
    lines.push(
      `${AGENT_WAKE_CUE} ${fromPeers.length} messages arrived from your teammates while ` +
        "you were idle.",
      "These are other agents reaching out, not the user typing.",
      ""
    );
    for (const message of fromPeers) {
      const flag = message.priority ? " (priority)" : "";
      lines.push(`${message.fromName} (id: ${message.fromId})${flag}: ${message.text}`);
    }
  }

  lines.push(
    "",
    "If this needs a reply or an action, handle it — reply with `SendToAgent` using the " +
      "sender's id, which reaches them on their own later turn. If it is an FYI with " +
      "nothing for you to do, end your turn without replying."
  );

  return lines.join("\n");
}

/** Combines user messages and peer wakes into the text for one turn. */
export function buildTurnPrompt(inbound: readonly InboundMessage[]): string {
  const fromUser = inbound.filter(message => message.fromId === "user");
  const fromPeers = inbound.filter(message => message.fromId !== "user");

  const parts: string[] = [];
  if (fromUser.length > 0) {
    parts.push(fromUser.map(message => message.text).join("\n\n"));
  }
  if (fromPeers.length > 0) {
    parts.push(buildWakePrompt(fromPeers));
  }
  return parts.join("\n\n---\n\n");
}
