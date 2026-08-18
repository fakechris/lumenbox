/**
 * Tool definitions and dispatch.
 *
 * Tool descriptions carry the *when* as well as the *what*: current models reach
 * for tools conservatively, and a description that only states functionality
 * measurably under-triggers.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { BoxClient } from "../box/client.ts";
import type { DisplayLease } from "../box/display-lease.ts";
import type { AgentBus } from "../agents/bus.ts";
import type { AgentRecord, AgentRegistry } from "../agents/registry.ts";
import type { ComputerAction } from "../protocol/index.ts";

export interface ToolContext {
  agent: AgentRecord;
  registry: AgentRegistry;
  bus: AgentBus;
  box: BoxClient | undefined;
  /** Exclusive claim on the box's single display. Absent means no gating. */
  display?: DisplayLease;
}

/** A tool result: text for the model, plus optional images. */
export interface ToolOutcome {
  text: string;
  /** base64 image payloads to attach to the tool result. */
  images?: { mediaType: "image/webp" | "image/png"; data: string }[];
  isError?: boolean;
}

const MOUSE_BUTTONS = ["left", "middle", "right", "back", "forward"] as const;
const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

const coordinateSchema = {
  type: "array" as const,
  description:
    "[x, y] in screenshot coordinates — the same space as the screenshots you receive.",
  items: { type: "number" as const },
  minItems: 2,
  maxItems: 2,
};

/**
 * One entry in a computer batch. Kept as a single flat object with an `action`
 * discriminator rather than a nested union, because models produce flat objects
 * far more reliably.
 */
const actionSchema = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: [
        "mouse_move",
        "click",
        "mouse_down",
        "mouse_up",
        "drag",
        "scroll",
        "type",
        "key",
        "wait",
        "screenshot",
        "cursor_position",
      ],
      description: "Which action to perform.",
    },
    coordinate: coordinateSchema,
    path: {
      type: "array" as const,
      description: "For drag: the points to move through, starting point first.",
      items: coordinateSchema,
    },
    button: {
      type: "string" as const,
      enum: [...MOUSE_BUTTONS],
      description: "Mouse button. Defaults to left.",
    },
    count: {
      type: "integer" as const,
      description: "Click count — 2 for a double-click. Defaults to 1.",
    },
    modifiers: {
      type: "string" as const,
      description:
        'Modifier keys held during the action, joined with "+", e.g. "ctrl" or "ctrl+shift". Use "meta" for Super/Command.',
    },
    direction: {
      type: "string" as const,
      enum: [...SCROLL_DIRECTIONS],
      description: "For scroll: which way.",
    },
    amount: {
      type: "integer" as const,
      description: "For scroll: how many wheel notches. Defaults to 3.",
    },
    text: {
      type: "string" as const,
      description:
        "For type: the literal text to type. Newlines are sent as Return presses.",
    },
    key: {
      type: "string" as const,
      description:
        'For key: an X keysym or chord, e.g. "Return", "Escape", "Tab", "ctrl+c", "F5".',
    },
    hold_duration_ms: {
      type: "integer" as const,
      description: "For key: hold the key down this long instead of tapping it.",
    },
    duration_ms: {
      type: "integer" as const,
      description: "For wait: how long to pause, in milliseconds.",
    },
  },
  required: ["action"],
};

export function buildTools(hasBox: boolean): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];

  if (hasBox) {
    tools.push(
      {
        name: "computer",
        description:
          "Interact with the Linux desktop in your box: move and click the mouse, type, " +
          "press keys, scroll, drag, and capture the screen. Call this whenever the task " +
          "involves something visual — a browser, a GUI application, a page you need to " +
          "read or click through. Every call returns a screenshot of the end state, so you " +
          "never need a separate screenshot call to see what happened. Pass several actions " +
          "in one call when the sequence is certain (click a field, type, press Enter) and " +
          "you will get one settled screenshot of the result; pass one action when you need " +
          "to see the outcome before choosing the next move. Coordinates are in the same " +
          "space as the screenshots you receive.",
        input_schema: {
          type: "object",
          properties: {
            actions: {
              type: "array",
              description: "The actions to perform, in order.",
              items: actionSchema,
              minItems: 1,
            },
          },
          required: ["actions"],
        },
      },
      {
        name: "bash",
        description:
          "Run a shell command inside your box. This is the right tool for anything a " +
          "terminal does better than a GUI: installing packages, inspecting and moving " +
          "files, running scripts or tests, checking whether a service is up, querying an " +
          "HTTP endpoint with curl. Prefer it over driving a GUI for the same result. " +
          "Returns stdout, stderr, and the exit code; a non-zero exit code is information, " +
          "not necessarily a failure to report. Commands run through bash, so pipes, " +
          "redirection, and globs work.",
        input_schema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command to run." },
            cwd: {
              type: "string",
              description: "Directory to run in. Defaults to the box home directory.",
            },
            timeout_ms: {
              type: "integer",
              description: "Kill the command after this long. Defaults to 120000.",
            },
          },
          required: ["command"],
        },
      },
      {
        name: "read_file",
        description:
          "Read a text file from your box. Use this instead of `cat` when you want the " +
          "content itself rather than shell output, and pass a line range when you only " +
          "need part of a large file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to the file." },
            start_line: {
              type: "integer",
              description: "First line to return, 1-indexed and inclusive.",
            },
            end_line: {
              type: "integer",
              description: "Last line to return, inclusive.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description:
          "Write a text file in your box, creating parent directories as needed and " +
          "overwriting any existing file at that path. Use this for creating scripts, " +
          "configuration, and notes — it is more reliable than heredocs through `bash`.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to write." },
            content: { type: "string", description: "The full file contents." },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "list_dir",
        description:
          "List a directory in your box, with entry types and sizes. Use it to orient " +
          "yourself before reading files, rather than guessing paths.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to the directory." },
          },
          required: ["path"],
        },
      }
    );
  }

  tools.push(
    {
      name: "SendToAgent",
      description:
        "Send a message to another of your user's agents. Delivery is fire-and-forget: it " +
        "wakes that agent and returns an acknowledgement immediately. It does NOT return " +
        "their reply, and you must not wait or poll for one in this turn — send it and move " +
        "on. Any reply arrives later as its own message that wakes you on a fresh turn. " +
        "Call this when a task genuinely belongs to a teammate's remit, or when you need " +
        "something only they have. Do not call it to acknowledge a message you just " +
        "received, and do not message several agents about the same effort unless the user " +
        "explicitly asked you to contact them — that wakes each one and buries the user in " +
        "replies. Get ids from your teammates list.",
      input_schema: {
        type: "object",
        properties: {
          target_id: {
            type: "string",
            description:
              "The recipient's agent id, taken from your teammates list — not their name.",
          },
          message: {
            type: "string",
            description:
              "What to say. Write it as if texting a colleague: lead with the ask, keep it short.",
          },
          priority: {
            type: "boolean",
            description:
              "When true, interrupt the recipient's current background work and wake them " +
              "immediately. Use only for stop/supersede or genuinely time-critical " +
              "instructions. Defaults to false, which waits out their current turn.",
          },
        },
        required: ["target_id", "message"],
      },
    },
    {
      name: "CreateAgent",
      description:
        "Create a new agent — a new teammate — with a name and a persona. Returns its id so " +
        "you can message it immediately. Use this when a body of work deserves a dedicated " +
        "owner with its own memory and chat. There is no tool to delete an agent, so only " +
        "create one that is genuinely worth keeping; the user removes agents themselves.",
      input_schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "A short human-readable name for the new agent.",
          },
          description: {
            type: "string",
            description:
              "The new agent's persona and remit: what it is for and how it should behave. " +
              "This becomes its system prompt, so write it as instructions to that agent.",
          },
          title: {
            type: "string",
            description: 'A short role label, e.g. "release manager".',
          },
        },
        required: ["name", "description"],
      },
    },
    {
      name: "UpdateAgent",
      description:
        "Edit another agent's name, description, or role label. Only the fields you pass " +
        "change; the rest are left exactly as they were, and there is no way to blank a " +
        "profile or remove an agent through this tool. Use it to refine a teammate's remit " +
        "as the work becomes clearer.",
      input_schema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "The id of the agent to update." },
          name: { type: "string", description: "New name. Omit to leave unchanged." },
          description: {
            type: "string",
            description: "New persona/remit. Omit to leave unchanged.",
          },
          title: { type: "string", description: "New role label. Omit to leave unchanged." },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "RememberFact",
      description:
        "Append a durable note to your own memory file, which is included in your system " +
        "prompt on every future turn. Use it for things that will still matter next " +
        "conversation: a decision the user made and why, a constraint about their setup, a " +
        "correction they gave you. Do not use it for what a tool can tell you again on " +
        "demand, or for details that only matter inside this conversation.",
      input_schema: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description:
              "The note to keep, as one or two self-contained sentences that will still " +
              "make sense without this conversation around them.",
          },
        },
        required: ["fact"],
      },
    }
  );

  return tools;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${text.length - max} more characters]`;
}

/** Formats an exec result the way a person reading a terminal would want it. */
function formatExec(result: {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
}): string {
  const parts: string[] = [];
  if (result.timed_out) parts.push("[command timed out and was killed]");
  parts.push(`exit code: ${result.exit_code}`);
  if (result.stdout.trim()) parts.push(`stdout:\n${truncate(result.stdout, 60_000)}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${truncate(result.stderr, 20_000)}`);
  if (!result.stdout.trim() && !result.stderr.trim()) parts.push("(no output)");
  return parts.join("\n\n");
}

function requireBox(context: ToolContext): BoxClient {
  if (!context.box) {
    throw new Error(
      "The box is not running, so this tool is unavailable. Tell the user to start it " +
        "with `agentbox box up`."
    );
  }
  return context.box;
}

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolOutcome> {
  switch (name) {
    case "computer": {
      const box = requireBox(context);
      const actions = input.actions as ComputerAction[] | undefined;
      if (!Array.isArray(actions) || actions.length === 0) {
        return { text: "`actions` must be a non-empty array.", isError: true };
      }

      // The desktop is exclusive: see DisplayLease. Refuse rather than queue, so
      // this agent can do something else instead of blocking invisibly.
      if (context.display && !context.display.acquire(context.agent.id)) {
        const holderId = context.display.heldBy()!;
        const holder = context.registry.tryGet(holderId);
        const seconds = Math.round(context.display.heldForMs() / 1000);
        return {
          text:
            `${holder?.profile.name ?? holderId} is using the box's desktop ` +
            `(for ${seconds}s). Only one agent can drive the screen at a time, because ` +
            "keystrokes and screenshots would otherwise cross between you. Do something " +
            "that does not need the screen — `bash` and the file tools still work — or " +
            "wait and try again.",
          isError: true,
        };
      }

      const result = await box.computer(actions);

      const notes: string[] = [];
      if (result.error) {
        notes.push(`The action sequence failed: ${result.error}`);
      } else {
        notes.push(`Ran ${result.action_count} action(s) in ${result.duration_ms}ms.`);
      }
      if (result.cursor_position) {
        notes.push(
          `Cursor is at (${result.cursor_position.x}, ${result.cursor_position.y}).`
        );
      }
      // Attach the screenshot on failure too — seeing the current state is how the
      // model works out what actually happened and what to try next.
      if (result.screenshot) {
        notes.push(
          result.error
            ? "A screenshot of the current screen is attached; check what state it is in before retrying."
            : "Screenshot of the resulting screen is attached."
        );
      }

      return {
        text: notes.join(" "),
        images: result.screenshot
          ? [{ mediaType: "image/webp", data: result.screenshot }]
          : undefined,
        isError: Boolean(result.error),
      };
    }

    case "bash": {
      const box = requireBox(context);
      const command = String(input.command ?? "");
      const result = await box.exec(command, {
        cwd: input.cwd ? String(input.cwd) : undefined,
        timeoutMs: input.timeout_ms ? Number(input.timeout_ms) : undefined,
      });
      return { text: formatExec(result) };
    }

    case "read_file": {
      const box = requireBox(context);
      const result = await box.readFile(String(input.path ?? ""), {
        startLine: input.start_line ? Number(input.start_line) : undefined,
        endLine: input.end_line ? Number(input.end_line) : undefined,
      });
      const header = result.truncated
        ? `${result.path} (showing part of ${result.total_lines} lines)`
        : `${result.path} (${result.total_lines} lines)`;
      return { text: `${header}\n\n${result.content}` };
    }

    case "write_file": {
      const box = requireBox(context);
      const result = await box.writeFile(
        String(input.path ?? ""),
        String(input.content ?? "")
      );
      return { text: `Wrote ${result.bytes_written} bytes to ${result.path}.` };
    }

    case "list_dir": {
      const box = requireBox(context);
      const result = await box.listDir(String(input.path ?? ""));
      if (result.entries.length === 0) return { text: `${result.path} is empty.` };
      const lines = result.entries.map(entry =>
        entry.type === "directory"
          ? `${entry.name}/`
          : `${entry.name}  (${entry.size} bytes)`
      );
      return { text: `${result.path}\n\n${lines.join("\n")}` };
    }

    case "SendToAgent": {
      const ack = context.bus.send({
        fromId: context.agent.id,
        toId: String(input.target_id ?? ""),
        text: String(input.message ?? ""),
        priority: input.priority === true,
      });
      return { text: ack };
    }

    case "CreateAgent": {
      const created = context.registry.create({
        name: String(input.name ?? ""),
        description: String(input.description ?? ""),
        title: input.title ? String(input.title) : undefined,
      });
      return {
        text:
          `Created agent "${created.profile.name}" (id: ${created.id}). ` +
          "Message it with SendToAgent using that id.",
      };
    }

    case "UpdateAgent": {
      const agentId = String(input.agent_id ?? "");
      const changes = {
        name: input.name === undefined ? undefined : String(input.name),
        description:
          input.description === undefined ? undefined : String(input.description),
        title: input.title === undefined ? undefined : String(input.title),
      };
      if (
        changes.name === undefined &&
        changes.description === undefined &&
        changes.title === undefined
      ) {
        return {
          text: "Nothing to update: provide a new name, description, or title.",
          isError: true,
        };
      }
      if (!context.registry.has(agentId)) {
        return { text: `No agent found with id ${agentId}.`, isError: true };
      }
      const updated = context.registry.update(agentId, changes);
      return {
        text: `Updated agent "${updated.profile.name}" (id: ${updated.id}).`,
      };
    }

    case "RememberFact": {
      const fact = String(input.fact ?? "").trim();
      if (!fact) return { text: "Nothing to remember.", isError: true };
      const existing = context.registry.readMemory(context.agent.id);
      const stamp = new Date().toISOString().slice(0, 10);
      const next = existing.trim()
        ? `${existing.trimEnd()}\n- (${stamp}) ${fact}\n`
        : `# Memory\n\n- (${stamp}) ${fact}\n`;
      context.registry.writeMemory(context.agent.id, next);
      return { text: "Noted in your memory file." };
    }

    default:
      return { text: `Unknown tool: ${name}`, isError: true };
  }
}
