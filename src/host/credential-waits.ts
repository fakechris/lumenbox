/**
 * The three places work starts, asking the coverage check first (INV-1666).
 *
 * `CredentialChecks` is the wiring: an agent's tool list, its box's bundles and skills, and the
 * vault and MCP servers of this installation, handed to `credentialCoverage` — so a task, a routine
 * and a template's setup are measured by one function against one picture of what is here.
 *
 * `CredentialWaits` is what a task does with a "missing": it does not start. The board row goes to
 * blocked with `waitingOn` naming what it waits for, the web hears a "before this can start" card,
 * and when a credential lands (the vault's change listener calls `recheck`) the same task is
 * released — opened again, and, when the chat path left a way to start it, started. A routine's
 * "missing" is the scheduler's skip-and-hold instead (schedule.ts `precheck`); it is resumed by a
 * person, from the attention list, like any other hold.
 */

import {
  beforeStartText,
  credentialCoverage,
  CREDENTIALS_WAITING_PREFIX,
  MISSING_CREDENTIALS,
  missingLine,
  mountedSkills,
  type Coverage,
  type CoverageAgent,
  type CoverageSkill,
  type CoverageWorld,
} from "./credential-coverage.ts";
import type { RoutineReason } from "./routine-runs.ts";
import type { Skill } from "./skills.ts";
import type { Task, TaskStore } from "./tasks.ts";

export interface CredentialChecksDeps {
  /** The agent by id or name, with its box's bundle needs; undefined for nobody. */
  agent: (idOrName: string) => (CoverageAgent & { boxId: string }) | undefined;
  /** The skills one box holds, as last read (synchronous: the caches are refreshed by their own readers). */
  skillsIn: (boxId: string | undefined) => readonly Skill[];
  /** What is here, for this agent: the vault, the servers, the environment, its bundles' grants. */
  world: (agent: CoverageAgent & { boxId: string }) => CoverageWorld;
}

export class CredentialChecks {
  constructor(private readonly deps: CredentialChecksDeps) {}

  /**
   * The agent's coverage for any task, plus whatever extra skills this start brings. `principalId`
   * is the person the work is for, whose `principal:` grants count. Undefined for an unknown agent.
   */
  forAgent(idOrName: string, extra: readonly CoverageSkill[] = [], principalId?: string): { agent: CoverageAgent; coverage: Coverage } | undefined {
    const found = this.deps.agent(idOrName);
    if (found === undefined) return undefined;
    const agent = principalId !== undefined ? { ...found, principalId } : found;
    const skills = [...mountedSkills(this.deps.skillsIn(agent.boxId), agent), ...extra];
    return { agent, coverage: credentialCoverage(agent, skills, this.deps.world(agent)) };
  }

  /**
   * The scheduler's check (schedule.ts `precheck`): the agent's own needs and the routine's. A slug
   * that is not a skill in its box (a host heartbeat) is not checked — it states no needs.
   */
  forRoutine(skill: { slug: string; boxId?: string }, agent: string): RoutineReason | undefined {
    const routine = this.deps.skillsIn(skill.boxId).find(entry => entry.slug === skill.slug);
    if (routine === undefined) return undefined;
    const checked = this.forAgent(agent, [routine]);
    if (checked === undefined || checked.coverage.ok) return undefined;
    return { code: MISSING_CREDENTIALS, text: `missing before it could start: ${missingLine(checked.coverage)}` };
  }

  /** For Settings → Team → Secrets: every agent with what it carries, for `neededBy`. */
  everyone(agents: readonly string[]): { agent: CoverageAgent; skills: readonly CoverageSkill[] }[] {
    return agents.flatMap(id => {
      const agent = this.deps.agent(id);
      return agent === undefined ? [] : [{ agent, skills: mountedSkills(this.deps.skillsIn(agent.boxId), agent) }];
    });
  }
}

/** What a waiting task announces, for the web's card. */
export type WaitEvent =
  | { kind: "needed"; taskId: string; title: string; agentId: string; agentName: string; coverage: Coverage }
  | { kind: "covered"; taskId: string; agentId: string };

export class CredentialWaits {
  /** How to start a task the chat path stopped, by task id. In memory: after a restart the row is opened and the person re-asks. */
  private readonly starts = new Map<string, () => Promise<void>>();

  constructor(
    private readonly deps: {
      tasks: () => Pick<TaskStore, "get" | "update" | "list"> | undefined;
      /** The coverage for this agent's work for this person (the task's requester). */
      check: (agentId: string, principalId: string) => { agent: CoverageAgent; coverage: Coverage } | undefined;
      announce?: (event: WaitEvent) => void;
      log?: (line: string) => void;
    }
  ) {}

  /**
   * Before a task's agent starts: the coverage when something is missing — the task is then blocked
   * and waiting, and `start` (if given) is how to begin it once the credential lands — or undefined
   * to go ahead. A task with nobody assigned states no needs.
   */
  gate(taskId: string, by: string, start?: () => Promise<void>): { coverage: Coverage; agentName: string } | undefined {
    const task = this.deps.tasks()?.get(taskId);
    if (task?.assigneeId === undefined) return undefined;
    const checked = this.deps.check(task.assigneeId, task.requester);
    if (checked === undefined || checked.coverage.ok) return undefined;
    const line = missingLine(checked.coverage);
    this.deps.tasks()?.update(taskId, { status: "blocked", waitingOn: `${CREDENTIALS_WAITING_PREFIX} ${line}`.slice(0, 500), note: `before this can start: ${line}`.slice(0, 500) }, by);
    if (start !== undefined) this.starts.set(taskId, start);
    this.deps.announce?.({ kind: "needed", taskId, title: task.title, agentId: checked.agent.id, agentName: checked.agent.name, coverage: checked.coverage });
    return { coverage: checked.coverage, agentName: checked.agent.name };
  }

  /** `gate` for a chat: the line it hears when the task waits, undefined to go ahead. */
  gateText(taskId: string, by: string, start?: () => Promise<void>): string | undefined {
    const held = this.gate(taskId, by, start);
    return held === undefined ? undefined : beforeStartText(held.coverage, held.agentName);
  }

  /** Whether this task is waiting on this check, by the board row alone (so a restart still finds it). */
  static waiting(task: Task): boolean {
    return task.status === "blocked" && (task.waitingOn ?? "").startsWith(CREDENTIALS_WAITING_PREFIX);
  }

  /**
   * After a credential changed: every task waiting here whose agent is now covered is released — the
   * row is opened again and, when the chat path left one, its start runs. Resolves with the released
   * ids once those starts have settled; a start that fails is logged, never thrown at the vault.
   */
  async recheck(): Promise<string[]> {
    const board = this.deps.tasks();
    if (board === undefined) return [];
    const released: string[] = [];
    const starting: Promise<void>[] = [];
    for (const task of board.list()) {
      if (!CredentialWaits.waiting(task) || task.assigneeId === undefined) continue;
      const checked = this.deps.check(task.assigneeId, task.requester);
      if (checked === undefined || !checked.coverage.ok) continue;
      board.update(task.id, { status: "open", waitingOn: null, note: "the credentials it was waiting on are in place" }, "host");
      released.push(task.id);
      this.deps.announce?.({ kind: "covered", taskId: task.id, agentId: task.assigneeId });
      const start = this.starts.get(task.id);
      this.starts.delete(task.id);
      if (start !== undefined) {
        starting.push(start().catch(error => this.deps.log?.(`credentials: ${task.id} could not start after its credentials landed — ${error instanceof Error ? error.message : String(error)}`)));
      }
    }
    await Promise.all(starting);
    return released;
  }
}
