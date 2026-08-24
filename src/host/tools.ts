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
import type { PolicyGate } from "./policy.ts";
import type { HostRunner } from "./host-runner.ts";
import type { Vault } from "./vault.ts";
import type { ScopeStore } from "./scopes.ts";
import type { McpManager } from "./mcp.ts";
import { delegateEnv, PRESETS, presetNamed, quoteForShell } from "./presets.ts";
import { describeHistory, readHistory } from "./history.ts";
import { dedupeKey, validateRecord } from "./memory.ts";
import { Claims, heldElsewhere } from "./claims.ts";
import { MAIN_CONVERSATION } from "../agents/registry.ts";
import { describeTask, isLive, isTaskStatus, TASK_STATUSES, type TaskStore } from "./tasks.ts";
import { ABSENT, versionOf, type FileVersions } from "./files.ts";
import {
  describeTodos,
  isTodoStatus,
  TODO_STATUSES,
  validatePlan,
  validateTodos,
  type TodoItem,
  type TodoStatus,
} from "./durable.ts";
import type { ComputerAction } from "../protocol/index.ts";

export interface ToolContext {
  agent: AgentRecord;
  /**
   * Who is driving, when the box was told.
   *
   * Used to record who a memory is about. Absent on a box driven directly, which is the single-user
   * case and where "about whom" has one answer.
   */
  caller?: { userId?: string };
  /**
   * Asked whether an action may happen, before it happens.
   *
   * Optional so every existing test and the CLI keep working without one, and absent means allow —
   * which is today's behaviour. Present, it is consulted for every tool call, including the ones
   * that reach the box and the ones that wake a teammate.
   */
  policy?: PolicyGate;
  /**
   * The MCP servers whose tools are on offer this turn. Absent means none, which is
   * every installation that has configured none — and every test.
   */
  mcp?: McpManager;
  /**
   * What each agent last saw each file as, so two of them writing one file is noticed.
   *
   * Optional and absent means no checking, which is what every turn did before and what a test that
   * is not about this wants.
   */
  files?: FileVersions;
  /**
   * Who has taken which piece of work. Absent means no claiming, which is what every turn did
   * before and what a test not about this wants.
   */
  claims?: Claims;
  registry: AgentRegistry;
  bus: AgentBus;
  box: BoxClient | undefined;
  /**
   * Which desktop this agent drives. Each agent has its own, so their input and
   * screenshots cannot cross.
   */
  displayIndex?: number;
  /**
   * This agent's claim on its own desktop, presented on every box call.
   *
   * The box refuses input for a desktop bound to someone else, which is what keeps one
   * agent out of another's screen — see AgentRegistry.boxOwnerTokenFor.
   */
  boxOwner?: string;
  /**
   * Guards one desktop against two agents. Normally moot now that displays are
   * per-agent, and kept for the case where two are deliberately pointed at one.
   */
  display?: DisplayLease;
  /**
   * The door out of the box, when an operator has built one. Absent means no host
   * execution — and, more than absent, the tool is not even offered, so an agent on a
   * box without this never learns it might have asked.
   */
  hostRunner?: HostRunner;
  /**
   * The credential vault. Present, a host command may ask for named secrets by their
   * grants; absent, the `secrets` argument is quietly nothing, since there is nowhere
   * to resolve it from.
   */
  vault?: Vault;
  /**
   * Which conversation this tool call belongs to. The shell session, the plan and the
   * todo list are all keyed on it, so two of an agent's conversations running at once
   * keep separate working directories and separate intent. Absent means the main one.
   */
  conversation?: string;
  /** The team's task board. Absent means the Tasks tool answers that there is none. */
  tasks?: TaskStore;
  /** The scopes registry, so a secret granted by the caller's scope resolves. */
  scopes?: ScopeStore;
  /**
   * The turn this call belongs to — the Run, in work-control terms. Recorded on every
   * task change an agent makes, which is what links a board movement back to the
   * transcript that is its evidence.
   */
  turnId?: string;
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
        "list_windows",
        "activate_window",
        "screenshot_window",
        "click_in_window",
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
    window_id: {
      type: "string" as const,
      description:
        'For activate_window, screenshot_window and click_in_window: an id from ' +
        'list_windows, e.g. "0x01e00003".',
    },
  },
  required: ["action"],
};

/**
 * Tools an agent is not allowed to be offered, by name.
 *
 * Withholding rather than refusing: a tool an agent cannot use should not be in its prompt at all.
 * Offering it and rejecting the call spends a round, teaches the model that its tool list is not
 * true, and produces a refusal the model then has to explain to somebody.
 *
 * Absent means everything, which is what every agent had before this existed.
 */
export function withheldFrom(
  allowed: readonly string[] | undefined,
  tools: readonly Anthropic.Tool[]
): Anthropic.Tool[] {
  if (allowed === undefined) return [...tools];
  const permitted = new Set(allowed);
  return tools.filter(tool => permitted.has(tool.name));
}

/**
 * The tool set for one turn.
 *
 * `vision` withholds the computer tool when the model cannot see image blocks.
 * Offering it anyway would be worse than useless: the agent would receive a note
 * saying a screenshot is attached, see nothing, and narrate a screen it invented.
 *
 * `allowed` narrows it further, per agent. Four agents holding identical tools are four agents
 * differing only in the prose that describes them — which is not a division of labour, it is a
 * division of tone. A reviewer that cannot write is a different thing from one that is asked not to.
 */
export function buildTools(
  hasBox: boolean,
  vision = true,
  allowed?: readonly string[],
  hasHostRunner = false,
  /**
   * Whether the desktop tool may be offered. False withholds `computer` while keeping
   * shell and files — the shape a side conversation runs in, so it does headless work
   * concurrently with the main one rather than fighting it for the single screen.
   */
  canUseDesktop = true
): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];

  if (hasBox && vision && canUseDesktop) {
    tools.push({
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
          "space as the screenshots you receive.\n\n" +
          "When a window you need is behind another one, do not hunt for it by eye. " +
          "`list_windows` gives you every window's id, title and geometry; " +
          "`activate_window` raises one and gives it focus, which you must do before " +
          "typing into it, because keystrokes go to whatever holds focus; and " +
          "`screenshot_window` reads one window's own contents even while it is covered, " +
          "for when you only need to read it. Coordinates in a window screenshot are the " +
          "window's own, measured from its top-left corner, not the screen's — so to act " +
          "on something you found there, use `click_in_window` with those coordinates " +
          "as they are. It raises the window and translates them for you.",
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
    });
  }

  // Shell and files do not need sight, so they stay available on a text-only model.
  if (hasBox) {
    tools.push(
      {
        name: "bash",
        description:
          "Run a shell command inside your box. A full Debian userland: git, curl, python3, " +
          "node, ffmpeg, the usual coreutils, and whatever you install. " +
          "Returns stdout, stderr, and the exit code; a non-zero exit code is information, " +
          "not necessarily a failure to report. Commands run through bash, so pipes, " +
          "redirection, and globs work. The session is stateful across calls: your working " +
          "directory and exported variables persist, so `cd` into a directory once and " +
          "later commands run there, and an activated virtualenv stays active. Use this to " +
          "modify files in place too — `sed -i`, a heredoc, or a short python script are " +
          "often better than rewriting a whole file with write_file.",
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
              description:
                "Kill the command after this long. Defaults to 120000, and the box will not " +
                "apply more than 600000 whatever is asked for.",
            },
            background: {
              type: "boolean",
              description:
                "Start it and answer immediately with a job id instead of waiting. Use this " +
                "for anything that outlives one call — a long build or test run, a server " +
                "you need running while you do something else, a delegated engine. Its " +
                "output goes to a file rather than into this result, so nothing is lost to " +
                "truncation. Then use `Jobs` to wait for it, read it, or stop it.",
            },
          },
          required: ["command"],
        },
      },
      {
        name: "Delegate",
        description:
          "Hand a self-contained piece of work to a specialist engine installed in your " +
          "box — deep work on a repository, where reading dozens of files and iterating " +
          "against tests is the job itself. Available engines: " +
          PRESETS.map(preset => `${preset.name} (${preset.summary})`).join(" ") +
          "\n\nIt runs as a background job, so you get a job id back and use `Jobs` to " +
          "wait for it and read what it did. Say what done looks like — the engine cannot " +
          "ask you a question, so an ambiguous brief comes back as confident work on the " +
          "wrong thing. It works in the directory you name and can change files there. " +
          "What it spends is billed to whoever asked you, like everything else you do.",
        input_schema: {
          type: "object",
          properties: {
            preset: {
              type: "string",
              enum: PRESETS.map(preset => preset.name),
              description: "Which engine.",
            },
            prompt: {
              type: "string",
              description:
                "The whole brief, self-contained: what to do, where, and what finished " +
                "looks like. It is the only thing the engine will be told.",
            },
            cwd: {
              type: "string",
              description: "Directory to work in — usually a repository checkout.",
            },
          },
          required: ["preset", "prompt"],
        },
      },
      {
        name: "Jobs",
        description:
          "The background commands you started with `bash` and background: true. " +
          "`list` shows them; `wait` blocks until one finishes, until a line you name " +
          "appears in its output, or until your timeout runs out — whichever comes " +
          "first, and it tells you which; `kill` stops one. Waiting for a line is how " +
          "you handle something that never exits: a server that has printed its ready " +
          "line is ready, and waiting for it to finish would wait forever. Every job's " +
          "full output is in a file, so read_file it when the tail a wait returns is " +
          "not enough.",
        input_schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "wait", "kill"] },
            job_id: { type: "string", description: "Which job, for wait and kill." },
            until: {
              type: "string",
              description:
                "For wait: stop waiting when this text appears in the output, instead of " +
                "only when the job exits.",
            },
            timeout_ms: {
              type: "integer",
              description: "For wait: how long to wait before answering. Defaults to 60000.",
            },
          },
          required: ["action"],
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
            overwrite: {
              type: "boolean",
              description:
                "Write even though the file has changed since you read it. Only after you have " +
                "looked and decided your version is the one that should survive.",
            },
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
      name: "SetPlan",
      description:
        "Write or replace your plan for the work you are doing. It goes in your system prompt on " +
        "every turn from now on, so it survives the conversation being summarised — which makes it " +
        "the one record of your intent that cannot be paraphrased away. Write one when the work " +
        "will take more than a few steps, and update it when the approach changes rather than " +
        "leaving a plan that contradicts what you are doing. Keep it to intent and shape; put " +
        "detail in a file under /home/box/work and point at it.",
      input_schema: {
        type: "object",
        properties: {
          plan: {
            type: "string",
            description:
              "Markdown. What you are trying to achieve, the approach, and anything you have " +
              "ruled out and why — that last part is what stops you re-trying it later.",
          },
        },
        required: ["plan"],
      },
    },
    {
      name: "SetTodos",
      description:
        "Replace your todo list. Like the plan, it survives summarisation, so it is how you know " +
        "what is left after a long piece of work. Send the whole list every time, not a change to " +
        "it. Keep it accurate in both directions: an item left pending after you finished it will " +
        "make you redo the work, and one marked done that is not will make you skip it.",
      input_schema: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The complete list, in the order you intend to work through it.",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "One line saying what this is." },
                status: {
                  type: "string",
                  enum: ["pending", "doing", "done", "blocked"],
                  description:
                    "blocked means something outside your control is in the way — say what in " +
                    "the text, because a blocked item with no reason cannot be helped.",
                },
              },
              required: ["text", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
    {
      name: "ReadHistory",
      description:
        "Search or read the recorded history of a conversation — what was actually said, what was " +
        "called, and what came back. Useful when the start of a conversation has been summarised " +
        "to fit: the originals were kept, and a summary is a paraphrase. Also how you check what a " +
        "teammate actually did rather than taking their account of it. Returns a bounded, compact " +
        "reading with entry numbers, not the raw content, so it will not undo the summarising.",
      input_schema: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description:
              "Words that must all appear. A plain word match, not a search that guesses at " +
              "meaning, so use words that would actually have been written.",
          },
          from: { type: "number", description: "First entry number to read, when reading a range." },
          to: { type: "number", description: "One past the last entry number." },
          agent: {
            type: "string",
            description:
              "Whose history, by id or name. Omit for your own. Reading a teammate's is how you " +
              "verify their work rather than trusting a summary of it.",
          },
        },
      },
    },
    {
      name: "ClaimWork",
      description:
        "Take a piece of work so a teammate does not take the same one, or hand it back when you " +
        "are done with it. Claiming something you already hold renews it. A claim lapses on its " +
        "own if it is not renewed, so nothing stays stuck when an agent stops.",
      input_schema: {
        type: "object",
        properties: {
          work: {
            type: "string",
            description:
              "What you are taking on, in one line, as you would describe it to a colleague. " +
              "Matching is on the words, so describing the same task differently from a teammate " +
              "will not collide — say what the task is rather than how you plan to do it.",
          },
          release: {
            type: "boolean",
            description: "Hand it back instead of taking it. Finished, or no longer doing it.",
          },
        },
        required: ["work"],
      },
    },
    {
      name: "RememberFact",
      description:
        "Keep something across conversations. It goes into your instructions on every future " +
        "turn. Use it for what will still matter next time: a decision the user made and why, a " +
        "constraint about their setup, a correction they gave you. Not for what a tool can tell " +
        "you again on demand, and not for details that only matter inside this conversation.",
      input_schema: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description:
              "The note to keep, as one or two self-contained sentences that will still " +
              "make sense without this conversation around them.",
          },
          scope: {
            type: "string",
            enum: ["self", "team"],
            description:
              "'team' shares it with every agent here and is right for anything about the person " +
              "or their setup — they should not have to tell each of us separately. 'self' is for " +
              "what only your own work needs, and is the default: a wrong 'team' costs everyone " +
              "prompt space forever, while a wrong 'self' costs one repeated question.",
          },
          replaces: {
            type: "string",
            description:
              "An earlier memory this one supersedes, quoted closely enough to recognise. Without " +
              "it the old one stays alongside the new one and both are presented to you later as " +
              "things you know.",
          },
        },
        required: ["fact"],
      },
    },
    {
      name: "Tasks",
      description:
        "The team's task board — work as an object everyone can see, not a message that " +
        "scrolls away. Use it when work outlives one reply: create a task before starting " +
        "something a teammate or the user will want to track, take a task before working " +
        "it so nobody duplicates you, move it as it progresses, and put a note on it when " +
        "something a successor needs to know happens. Statuses: open (nobody on it), " +
        "doing, blocked (say why in the note), review (finished, awaiting acceptance), " +
        "done, dropped. If a task names a reviewer, only the reviewer can move it to " +
        "done — your finish is `review`, and that is not a formality you can skip. " +
        "Your own live tasks are already in your instructions every turn; `list` is for " +
        "seeing the whole board.",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "take", "update", "list"],
            description:
              "create a task; take one (assigns it to you, status doing); update one's " +
              "status/note/assignee; list the board.",
          },
          id: { type: "string", description: "The task id, e.g. \"t12\". For take and update." },
          title: { type: "string", description: "For create: one line of what is to be done." },
          description: { type: "string", description: "For create: details a stranger would need." },
          status: {
            type: "string",
            enum: [...TASK_STATUSES],
            description: "For update: where it is now.",
          },
          note: {
            type: "string",
            description: "For update: what happened — a blocker, a finding, a handoff note.",
          },
          assignee: {
            type: "string",
            description:
              "For create or update: an agent's id or name to put on it. Omit on create to " +
              "leave it open for anyone.",
          },
          reviewer: {
            type: "string",
            description:
              "For create: who must accept it before it is done. Name a reviewer for work " +
              "worth a second pair of eyes; leave off for routine work.",
          },
          list_status: {
            type: "string",
            enum: [...TASK_STATUSES],
            description: "For list: only this status. Omit for everything live.",
          },
        },
        required: ["action"],
      },
    }
  );

  // The door out of the box, only when an operator has built one. Not added-and-
  // withheld — absent, so a box without host execution never puts the idea in an
  // agent's prompt.
  if (hasHostRunner) {
    tools.push({
      name: "RunOnHost",
      description:
        "Run a command on the person's own computer — the machine LumenBox runs on, " +
        "outside your box. This is how you reach things the box cannot: a device on a " +
        "USB port, AppleScript that drives desktop apps, or a command-line tool " +
        "installed on the host such as `pi`, `claude`, `codex`, `git` against a local " +
        "checkout, or `arduino-cli`. It runs under a directory the operator chose, " +
        "through their shell, so their PATH and aliases apply. " +
        "Every call stops for the person to approve the exact command before it runs, " +
        "so write the command you mean and say in your message why you need it. " +
        "Returns stdout, stderr and the exit code, the same as `bash`.\n\n" +
        "If the command needs a credential — a token to push to git, an API key — name " +
        "the vault secrets it needs in `secrets`, and they are placed in the command's " +
        "environment for that one run. They live on the host, never enter your box, and " +
        "are yours to use only if a person has granted them to you. You never see the " +
        "values; you refer to them by the environment variable name the operator chose.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run on the host." },
          secrets: {
            type: "array",
            items: { type: "string" },
            description:
              "Vault secret ids to place in the command's environment for this run, " +
              "e.g. [\"GITHUB_TOKEN\"]. Each must be granted to you; an ungranted one " +
              "is left out and named back to you.",
          },
        },
        required: ["command"],
      },
    });
  }

  return withheldFrom(allowed, tools);
}

/**
 * Truncates from the middle, keeping both ends.
 *
 * Head-only truncation throws away the part that usually matters: a build prints
 * thousands of lines of progress and then the error that stopped it. Keeping only
 * the head hands the model the noise and drops the answer.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const dropped = text.length - max;
  return (
    `${text.slice(0, half)}\n\n... [${dropped} characters omitted] ...\n\n` +
    text.slice(text.length - half)
  );
}

/** Formats an exec result the way a person reading a terminal would want it. */
function formatExec(
  result: {
    stdout: string;
    stderr: string;
    exit_code: number;
    timed_out: boolean;
    timeout_ms?: number;
  },
  requestedTimeoutMs?: number
): string {
  const parts: string[] = [];
  if (result.timed_out) {
    const applied = result.timeout_ms;
    // Which timeout killed it, and whether it was the one asked for. A command killed at ten
    // minutes after a request for an hour looks like a crash unless the cap is named.
    const capped =
      applied !== undefined && requestedTimeoutMs !== undefined && requestedTimeoutMs > applied
        ? ` — the box caps a single command at ${applied}ms, so the ${requestedTimeoutMs}ms you ` +
          `asked for was not applied. For longer work, start it detached and poll it.`
        : applied !== undefined
          ? ` after ${applied}ms`
          : "";
    parts.push(`[command timed out and was killed${capped}]`);
  }
  parts.push(`exit code: ${result.exit_code}`);
  // Caps chosen so one `npm install` or one `cat` of a log cannot eat the context.
  if (result.stdout.trim()) parts.push(`stdout:\n${truncate(result.stdout, 20_000)}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${truncate(result.stderr, 10_000)}`);
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
  // Before the switch, so no tool can be added later that quietly bypasses it. A refusal comes back
  // as a tool error, which is the shape the model already knows how to read: it sees why, and can
  // stop or ask, rather than retrying into a wall.
  const decision = context.policy?.check({
    kind: "tool",
    agentId: context.agent.id,
    agentName: context.agent.profile.name,
    tool: name,
    input,
  });
  if (decision !== undefined && !decision.allow) {
    return { text: decision.reason, isError: true };
  }

  switch (name) {
    case "computer": {
      const box = requireBox(context);
      const actions = input.actions as ComputerAction[] | undefined;
      if (!Array.isArray(actions) || actions.length === 0) {
        return { text: "`actions` must be a non-empty array.", isError: true };
      }

      // Two agents on one desktop would type into each other's windows. With a
      // display each this never fires; it still guards the case where two are
      // pointed at the same one.
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

      const result = await box.computer(actions, {
        display: context.displayIndex,
        owner: context.boxOwner,
      });

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
      if (result.windows) {
        // As text, not as an image: these are ids to be copied into the next call, and a
        // model reading an id off a screenshot gets it wrong.
        const rows = result.windows
          // -1 is the desktop layer and the dock; nobody means those by "window".
          .filter(window => window.desktop >= 0)
          .map(
            window =>
              `${window.id}  ${window.width}x${window.height}` +
              ` at (${window.x},${window.y})  ${window.title}`
          );
        notes.push(
          rows.length > 0
            ? `Windows on your desktop:\n${rows.join("\n")}`
            : "No application windows are open on your desktop."
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
      if (input.background === true) {
        const started = await box.startJob(command, {
          ...(input.cwd ? { cwd: String(input.cwd) } : {}),
          ...(context.displayIndex !== undefined ? { display: context.displayIndex } : {}),
          ...(context.boxOwner !== undefined ? { owner: context.boxOwner } : {}),
        });
        return {
          text:
            `Started as ${started.job_id} (pid ${started.pid}).\n` +
            `Its output is going to ${started.log_path} — read_file it any time.\n` +
            `Use Jobs to wait for it, watch for a line, or stop it. It keeps running ` +
            `whether or not you wait.`,
        };
      }
      const result = await box.exec(command, {
        cwd: input.cwd ? String(input.cwd) : undefined,
        timeoutMs: input.timeout_ms ? Number(input.timeout_ms) : undefined,
        // Per-agent AND per-conversation session, so each agent keeps its own working
        // directory and environment without inheriting a teammate's — and two of its
        // own conversations running at once do not cross cwd or env either.
        session: `${context.agent.id}/${context.conversation ?? MAIN_CONVERSATION}`,
        // So a GUI the agent launches from the shell opens on its own desktop.
        display: context.displayIndex,
        owner: context.boxOwner,
      });
      return {
        text: formatExec(result, input.timeout_ms ? Number(input.timeout_ms) : undefined),
      };
    }

    case "Delegate": {
      const box = requireBox(context);
      const preset = presetNamed(String(input.preset ?? ""));
      if (preset === undefined) {
        return {
          text: `No preset named ${String(input.preset ?? "")}. Installed: ${PRESETS.map(p => p.name).join(", ")}.`,
          isError: true,
        };
      }
      const prompt = String(input.prompt ?? "").trim();
      if (prompt === "") {
        return { text: "Delegating needs a brief; the engine cannot ask you what you meant.", isError: true };
      }
      // Checked rather than assumed, and said as an install problem rather than as a
      // failed run: an engine that is not there produces a shell error the model would
      // otherwise try to debug.
      const probe = await box.exec(preset.probe, { timeoutMs: 15_000 });
      if (probe.exit_code !== 0) {
        return {
          text:
            `The ${preset.name} engine is not installed in this box. An operator adds it ` +
            `to the image — it is a pinned part of the box, not something to install ` +
            `mid-task.`,
          isError: true,
        };
      }
      const env = delegateEnv(preset);
      const started = await box.startJob(preset.run(quoteForShell(prompt)), {
        ...(input.cwd ? { cwd: String(input.cwd) } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(context.boxOwner !== undefined ? { owner: context.boxOwner } : {}),
      });
      return {
        text:
          `Delegated to ${preset.name} as ${started.job_id}.\n` +
          `Its work is going to ${started.log_path}.\n` +
          (Object.keys(env).length > 0
            ? "It is billed through this installation, so its spend is on the same budget as yours.\n"
            : "No model relay is configured here, so it is using whatever credential the box " +
              "itself has — if it has none, it will say so in its output.\n") +
          `Use Jobs to wait for it. It is doing the work; you are still the one who ` +
          `has to check it did the right thing.`,
      };
    }

    case "Jobs": {
      const box = requireBox(context);
      const action = String(input.action ?? "list");
      if (action === "list") {
        const { jobs } = await box.jobs();
        if (jobs.length === 0) return { text: "No background jobs." };
        return {
          text: jobs
            .map(
              job =>
                `${job.job_id} ${job.running ? "running" : `exited ${job.exit_code}`} — ` +
                `${job.command.slice(0, 80)} (${job.log_bytes} bytes at ${job.log_path})`
            )
            .join("\n"),
        };
      }
      const jobId = String(input.job_id ?? "");
      if (jobId === "") return { text: "Which job? Pass job_id.", isError: true };
      if (action === "kill") {
        const killed = await box.killJob(jobId);
        return { text: `${killed.job_id} stopped. Its output is at ${killed.log_path}.` };
      }
      if (action !== "wait") {
        return { text: `Unknown Jobs action: ${action}. Use list, wait or kill.`, isError: true };
      }
      const waited = await box.waitForJob({
        job_id: jobId,
        ...(input.until !== undefined ? { until: String(input.until) } : {}),
        ...(input.timeout_ms !== undefined ? { timeout_ms: Number(input.timeout_ms) } : {}),
      });
      // The reason is said first and plainly: "still running" and "finished" call for
      // different next moves, and a tail alone does not distinguish them.
      const headline =
        waited.reason === "exited"
          ? `${waited.job_id} finished with exit code ${waited.exit_code}.`
          : waited.reason === "matched"
            ? `${waited.job_id} printed what you were waiting for. It is still running.`
            : `${waited.job_id} is still running; the wait timed out.`;
      return {
        text:
          `${headline}\nFull output: ${waited.log_path} (${waited.log_bytes} bytes)\n\n` +
          `--- the last of it ---\n${waited.tail}`,
      };
    }

    case "RunOnHost": {
      // The policy gate above already required approval for this call, so reaching
      // here means a person read the command and allowed it. The runner is still
      // checked, because "enabled" can change and the tool could linger in a prompt
      // built a moment earlier.
      if (context.hostRunner === undefined || !context.hostRunner.enabled) {
        return {
          text: "Host execution is not available on this box.",
          isError: true,
        };
      }
      const command = String(input.command ?? "").trim();
      if (command === "") return { text: "`command` is required.", isError: true };

      // Named secrets, resolved through the vault against this agent's grants. Every
      // resolution is audited inside the vault; a refused one is left out of the
      // environment and named back, so the model learns it lacks the grant rather
      // than the command failing opaquely.
      const secretEnv: Record<string, string> = {};
      const refusedSecrets: string[] = [];
      const asked = Array.isArray(input.secrets) ? (input.secrets as unknown[]) : [];
      for (const raw of asked) {
        const secretId = String(raw);
        const value = context.vault?.resolve(secretId, {
          agentId: context.agent.id,
          agentName: context.agent.profile.name,
          ...(context.caller?.userId !== undefined ? { principalId: context.caller.userId } : {}),
          // A scope the agent is in can grant the secret without a direct vault grant.
          scopeGrants: context.scopes?.grantsSecret(context.agent.profile.scopeId, secretId) === true,
        });
        if (value === undefined) refusedSecrets.push(secretId);
        else secretEnv[secretId] = value;
      }

      try {
        const result = await context.hostRunner.run(command, secretEnv);
        const parts = [
          result.stdout.trim() !== "" ? result.stdout : "(no stdout)",
          result.stderr.trim() !== "" ? `stderr:\n${result.stderr}` : "",
          result.timedOut ? "The command hit the host time limit and was killed." : "",
          result.truncatedBytes > 0
            ? `(${result.truncatedBytes} bytes of output dropped for length.)`
            : "",
          refusedSecrets.length > 0
            ? `Not run with these secrets — you have not been granted them: ${refusedSecrets.join(", ")}.`
            : "",
          `exit code: ${result.code === null ? "unknown" : result.code}`,
        ].filter(part => part !== "");
        return { text: parts.join("\n\n"), isError: result.code !== 0 && !result.timedOut };
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    }

    case "read_file": {
      const box = requireBox(context);
      const result = await box.readFile(String(input.path ?? ""), {
        startLine: input.start_line ? Number(input.start_line) : undefined,
        endLine: input.end_line ? Number(input.end_line) : undefined,
      });
      // Only a whole-file read establishes what this agent has seen. A range read tells it about
      // part of the file, and treating that as knowledge of the whole would let it overwrite the
      // rest on the strength of having looked at ten lines.
      if (!result.truncated) {
        context.files?.observed(context.agent.id, result.path, versionOf(result.content));
      }
      const header = result.truncated
        ? `${result.path} (showing part of ${result.total_lines} lines)`
        : `${result.path} (${result.total_lines} lines)`;
      return { text: `${header}\n\n${result.content}` };
    }

    case "write_file": {
      const box = requireBox(context);
      const path = String(input.path ?? "");
      const content = String(input.content ?? "");

      // What the file is right now, read immediately before writing. Compared against what this
      // agent last saw, which is what turns "the second write wins silently" into a refusal.
      if (context.files !== undefined && input.overwrite !== true) {
        // Three outcomes, kept apart: a version we can compare, a file that is genuinely absent
        // (creating it is safe), and a read that *failed* — which is not the same as absent. A
        // transient daemon error or a permission fault used to collapse to ABSENT, the one state
        // the check always permits, so a hiccup while reading an existing file let the next write
        // silently overwrite it. "Could not read" and "not there" are opposite answers.
        let current: string | undefined;
        try {
          const existing = await box.readFile(path);
          current = existing.truncated ? undefined : versionOf(existing.content);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/does not exist|no such file/i.test(message)) {
            current = ABSENT;
          } else {
            return {
              text:
                `${path} could not be read to check whether it changed since you last saw it ` +
                `(${message}). It was not written, because a read failure is not the same as the ` +
                `file being absent. Try again, or pass overwrite: true if you mean to replace it ` +
                `whatever it now holds.`,
              isError: true,
            };
          }
        }
        if (current === undefined) {
          // Too large to read whole, so there is nothing to compare against. Refused rather than
          // allowed: "I could not check" and "I checked and it is fine" are different answers, and
          // letting the first pass as the second is how the guarantee quietly stops applying to
          // exactly the biggest files. The way through is the same deliberate flag as any other
          // conflict.
          return {
            text:
              `${path} is too large to read in full, so there is no way to tell whether it has ` +
              `changed since you last saw it. It was not written. If you mean to replace it ` +
              `whatever it now contains, pass overwrite: true.`,
            isError: true,
          };
        }
        const { refusal } = context.files.check({
          agentId: context.agent.id,
          path,
          current,
          nameOf: id => context.registry.tryGet(id)?.profile.name ?? id,
        });
        if (refusal !== undefined) return { text: refusal, isError: true };
      }

      const result = await box.writeFile(path, content);
      // Its own write is the newest thing it has seen, so writing twice in a row is not a conflict
      // with itself.
      context.files?.observed(context.agent.id, result.path, versionOf(content));
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
      const targetId = String(input.target_id ?? "");
      // Checked as a wake rather than as a tool call, because the limit that matters here is on how
      // often agents set each other going — the shape that produces a loop nothing else stops.
      const target = context.registry.tryGet(targetId);
      const wake = context.policy?.check({
        kind: "wake",
        agentId: context.agent.id,
        agentName: context.agent.profile.name,
        targetId,
        targetName: target?.profile.name ?? targetId,
      });
      if (wake !== undefined && !wake.allow) return { text: wake.reason, isError: true };

      const ack = context.bus.send({
        fromId: context.agent.id,
        toId: targetId,
        text: String(input.message ?? ""),
        priority: input.priority === true,
      });
      return { text: ack };
    }

    case "SetPlan": {
      const plan = String(input.plan ?? "");
      const rejected = validatePlan(plan);
      // Returned as an error so the model reads it and can act: a refusal that does not say what
      // would be accepted produces a retry of the same thing.
      if (rejected !== undefined) return { text: rejected.reason, isError: true };
      context.registry.writePlan(context.agent.id, plan, context.conversation);
      return {
        text:
          "Plan saved. It is in your system prompt from the next turn, and in this turn it is the " +
          "text above — so you can act on it now.",
      };
    }

    case "SetTodos": {
      // Refused, not treated as an empty list. `todos` arriving as an object or a string used to
      // become `[]`, which then *replaced* the real list — so a malformed call silently erased the
      // work an agent was tracking, and the echo told it the list was empty as though it had meant
      // that. Clearing the list is a real thing to want, which is exactly why it has to be said
      // rather than inferred from a shape that did not parse.
      if (!Array.isArray(input.todos)) {
        return {
          text:
            `SetTodos needs \`todos\` to be a list. Nothing was changed. To clear the list, pass ` +
            `an empty one: {"todos": []}.`,
          isError: true,
        };
      }
      const raw = input.todos;
      const badStatus = raw
        .map(entry => String((entry as { status?: unknown })?.status ?? "pending"))
        .find(status => !isTodoStatus(status));
      if (badStatus !== undefined) {
        // Also refused rather than coerced to "pending". Silently downgrading a status means the
        // list says something the agent did not say, and the agent has no way to notice.
        return {
          text:
            `"${badStatus}" is not a todo status. Use one of: ${TODO_STATUSES.join(", ")}. ` +
            `Nothing was changed.`,
          isError: true,
        };
      }
      const todos: TodoItem[] = raw.map(entry => {
        const item = entry as { text?: unknown; status?: unknown };
        return {
          text: String(item.text ?? "").trim(),
          status: String(item.status ?? "pending") as TodoStatus,
        };
      });
      const rejected = validateTodos(todos);
      if (rejected !== undefined) return { text: rejected.reason, isError: true };
      context.registry.writeTodos(context.agent.id, todos, context.conversation);
      // The whole new list, echoed back. The system prompt is built once per turn, so this is what
      // makes an update at round 5 visible at round 300.
      return { text: describeTodos(todos) };
    }

    case "CreateAgent": {
      const created = context.registry.create({
        name: String(input.name ?? ""),
        description: String(input.description ?? ""),
        title: input.title ? String(input.title) : undefined,
        // A colleague cannot be given tools its creator does not have. Without this, an agent that
        // may not write files creates one that may and asks it to write — and the restriction was
        // never a restriction, only a longer path. Same rule as a teammate's message carrying no
        // authority: nothing here can grant what the granter does not hold.
        ...(context.agent.profile.tools !== undefined
          ? { tools: context.agent.profile.tools }
          : {}),
      });
      const inherited =
        context.agent.profile.tools === undefined
          ? ""
          : " It has the same tools you do — an agent cannot hand out what it does not hold.";
      return {
        text:
          `Created agent "${created.profile.name}" (id: ${created.id}). ` +
          `Message it with SendToAgent using that id.${inherited}`,
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

    case "ReadHistory": {
      const who = String(input.agent ?? "").trim();
      // A teammate's history is readable on purpose: everyone here shares a box and a filesystem
      // already, `private` is documented as accident prevention rather than a boundary, and the
      // reviewer's whole job — promised in its description — is checking what someone actually did
      // rather than what they said they did.
      let target = context.agent;
      if (who !== "" && who !== context.agent.id && who !== context.agent.profile.name) {
        const found = context.registry.tryGet(who) ?? context.registry.list().find(
          record => record.profile.name.toLowerCase() === who.toLowerCase()
        );
        if (found === undefined) return { text: `No agent "${who}".`, isError: true };
        target = found;
      }

      const entries = context.registry.readTranscript(target.id);
      const query = {
        ...(typeof input.search === "string" && input.search.trim() !== ""
          ? { search: input.search.trim() }
          : {}),
        ...(typeof input.from === "number" ? { from: input.from } : {}),
        ...(typeof input.to === "number" ? { to: input.to } : {}),
      };
      const whose = target.id === context.agent.id ? "" : `${target.profile.name}: `;
      return { text: whose + describeHistory(readHistory(entries, query), query) };
    }

    case "Tasks": {
      const board = context.tasks;
      if (board === undefined) {
        return { text: "There is no task board on this installation.", isError: true };
      }
      const action = String(input.action ?? "");
      const nameOf = (id: string) => context.registry.tryGet(id)?.profile.name ?? id;
      /** An id or a name; teammates say names, the board stores ids. */
      const resolveAgent = (raw: string): string | undefined => {
        const direct = context.registry.tryGet(raw);
        if (direct !== undefined) return direct.id;
        const byName = context.registry
          .list()
          .find(agent => agent.profile.name.toLowerCase() === raw.toLowerCase());
        return byName?.id;
      };

      if (action === "list") {
        const wanted = String(input.list_status ?? "");
        const all = isTaskStatus(wanted)
          ? board.list({ status: wanted })
          : board.list().filter(task => isLive(task.status));
        if (all.length === 0) return { text: "The board is empty for that view." };
        return { text: all.map(task => describeTask(task, nameOf)).join("\n") };
      }

      if (action === "create") {
        const assigneeRaw = String(input.assignee ?? "").trim();
        const reviewerRaw = String(input.reviewer ?? "").trim();
        const assigneeId = assigneeRaw === "" ? undefined : resolveAgent(assigneeRaw);
        const reviewerId = reviewerRaw === "" ? undefined : resolveAgent(reviewerRaw);
        if (assigneeRaw !== "" && assigneeId === undefined) {
          return { text: `No agent called "${assigneeRaw}" to assign.`, isError: true };
        }
        if (reviewerRaw !== "" && reviewerId === undefined) {
          return { text: `No agent called "${reviewerRaw}" to review.`, isError: true };
        }
        const created = board.create({
          title: String(input.title ?? ""),
          ...(typeof input.description === "string" ? { description: input.description } : {}),
          requester: context.agent.id,
          ...(assigneeId !== undefined ? { assigneeId } : {}),
          ...(reviewerId !== undefined ? { reviewerId } : {}),
          ...(context.conversation !== undefined ? { conversation: context.conversation } : {}),
        });
        if (created === undefined) return { text: "A task needs a title.", isError: true };
        return { text: `Created ${describeTask(created, nameOf)}.` };
      }

      if (action === "take") {
        const taken = board.update(
          String(input.id ?? ""),
          { assigneeId: context.agent.id, status: "doing" },
          context.agent.id,
          context.turnId
        );
        if (taken === undefined) {
          return { text: `No task ${String(input.id ?? "")} on the board.`, isError: true };
        }
        return { text: `You are on it: ${describeTask(taken.task, nameOf)}.` };
      }

      if (action === "update") {
        const status = String(input.status ?? "");
        const assigneeRaw = String(input.assignee ?? "").trim();
        const assigneeId = assigneeRaw === "" ? undefined : resolveAgent(assigneeRaw);
        if (assigneeRaw !== "" && assigneeId === undefined) {
          return { text: `No agent called "${assigneeRaw}" to assign.`, isError: true };
        }
        const updated = board.update(
          String(input.id ?? ""),
          {
            ...(isTaskStatus(status) ? { status } : {}),
            ...(typeof input.note === "string" && input.note.trim() !== ""
              ? { note: input.note }
              : {}),
            ...(assigneeId !== undefined ? { assigneeId } : {}),
          },
          context.agent.id,
          context.turnId
        );
        if (updated === undefined) {
          return { text: `No task ${String(input.id ?? "")} on the board.`, isError: true };
        }
        return {
          text:
            `${describeTask(updated.task, nameOf)}.` +
            (updated.coerced !== undefined ? `\n\n${updated.coerced}` : ""),
        };
      }

      return { text: `Unknown action "${action}". Use create, take, update or list.`, isError: true };
    }

    case "ClaimWork": {
      const work = String(input.work ?? "").trim();
      if (work === "") {
        return {
          text: "Say what the work is, in one line. An empty claim collides with everything or nothing.",
          isError: true,
        };
      }
      if (context.claims === undefined) {
        return { text: "Work claims are not available here, so nothing was recorded.", isError: true };
      }

      if (input.release === true) {
        context.claims.release(context.agent.id, work);
        return { text: `Released. Anyone can pick up "${work}" now.` };
      }

      const taken = context.claims.claim({ agentId: context.agent.id, about: work });
      if (!taken.ok) {
        return {
          text: heldElsewhere(taken.held, id => context.registry.tryGet(id)?.profile.name ?? id),
          isError: true,
        };
      }
      return {
        text: taken.renewed
          ? `Still yours. The claim on "${work}" is renewed.`
          : `Claimed. "${work}" is yours until you release it or it lapses.`,
      };
    }

    case "RememberFact": {
      const fact = String(input.fact ?? "").trim();
      const rejected = validateRecord(fact);
      if (rejected !== undefined) return { text: rejected.reason, isError: true };

      // A deliberate act, so it is stored as a `fact` — trusted, and barely decaying. Something the
      // agent chose to keep should not age out the way an automatic extraction does.
      const shared = String(input.scope ?? "self") === "team";
      const key = dedupeKey(fact);
      // Checked against both tiers whichever was asked for: an agent should not keep its own copy of
      // something a colleague already shared, and should not share what it already knows privately
      // without that being visible.
      const own = context.registry.readMemoryRecords(context.agent.id);
      const team = context.registry.readSharedMemory();

      // What this fact withdraws, if anything. Written as its own record rather than by editing the
      // file: memory is an append-only log of what was believed when, and that is what makes a
      // wrong correction recoverable. Without this, memory could only accrete — an agent could
      // record that it had learned better but not withdraw what it had learned wrongly, so both
      // sat in the prompt, dated and presented as things it knows.
      const replaces = String(input.replaces ?? "").trim();
      let retracted = false;
      if (replaces !== "") {
        const target = dedupeKey(replaces);
        const retraction = {
          at: new Date().toISOString(),
          kind: "retraction" as const,
          text: replaces,
          source: "RememberFact.replaces",
        };
        if (target !== "" && own.some(record => dedupeKey(record.text) === target)) {
          context.registry.appendMemoryRecords(context.agent.id, [retraction]);
          retracted = true;
        }
        if (target !== "" && team.some(record => dedupeKey(record.text) === target)) {
          context.registry.appendSharedMemory(context.agent.id, [retraction]);
          retracted = true;
        }
        if (!retracted) {
          // Said, because an agent that believes it corrected something and did not will act on
          // the correction while the prompt keeps showing the old line.
          return {
            text:
              `Nothing remembered matches "${replaces}", so nothing was withdrawn and nothing was ` +
              `added. Quote the memory you mean more closely, or leave \`replaces\` out to keep ` +
              `this as a new one alongside it.`,
            isError: true,
          };
        }
      }

      if ([...own, ...team].some(record => dedupeKey(record.text) === key)) {
        // Told, not silently swallowed: an agent that thinks a write failed will write it again in
        // different words, which is exactly what the dedupe key exists to prevent.
        return { text: "That is already remembered, here or by a teammate, so nothing was added." };
      }

      const record = {
        at: new Date().toISOString(),
        kind: "fact" as const,
        text: fact,
        source: "RememberFact",
        // Who it is about, when the box was told. Without it a fact learned from one person reads as
        // being about whoever asks next, which in a team is worse than not recording it.
        ...(context.caller?.userId !== undefined ? { about: context.caller.userId } : {}),
      };
      const withdrawn = retracted ? " The one it replaces has been withdrawn." : "";
      if (shared) {
        context.registry.appendSharedMemory(context.agent.id, [record]);
        return {
          text: `Kept and shared. Every agent here will have it on their next turn.${withdrawn}`,
        };
      }
      context.registry.appendMemoryRecords(context.agent.id, [record]);
      return { text: `Kept. It will be in your instructions on future turns.${withdrawn}` };
    }

    default: {
      // An MCP server's tool, if one claims the name. Reached last, so nothing here can
      // be shadowed by an external server — and reached *after* the policy gate above,
      // like every other call, so an external tool is governed exactly as ours are.
      if (context.mcp?.owns(name) === true) {
        try {
          return { text: await context.mcp.call(name, input) };
        } catch (error) {
          return {
            text: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      }
      return { text: `Unknown tool: ${name}`, isError: true };
    }
  }
}
