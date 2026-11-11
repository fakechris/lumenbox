/** Durable admission context, shared by the bus and the turn reader. */
import type { TaskBinding } from "../host/execution-binding.ts";
import type { GoalMarker } from "../host/goal-mode.ts";
import type { ResumeMarker } from "../host/resume.ts";
import type { Lane } from "./bus.ts";

export interface InboundMessage {
  /** Explicit transport relation; no component infers task ownership from conversation activity. */
  workRelation?: "new" | "continue";
  /** Host-stamped root work. Agent tools cannot choose its identity or participants. */
  work?: import("./work-attention.ts").WorkStamp; informational?: true;
  /** Host-only review snapshot; persisted with admission, never parsed from model prose. */
  audit?: import("../host/audit-context.ts").AuditContext;
  /** Host-only continuation lineage, persisted with the admission. */
  resumeOf?: ResumeMarker;
  /** Authenticated host identity, frozen at admission; never supplied by an agent tool. */
  principalId?: string;
  fromId: string;
  fromName: string;
  text: string;
  priority: boolean;
  receivedAt: string;
  /**
   * Carried by the host on the sender's behalf rather than sent with `SendToAgent`: a prose
   * reply on a teammate-woken turn, a task assignment, a new agent's first message. A turn
   * woken by a relayed message does not relay its own prose back, which is what keeps two
   * agents from bouncing "noted" at each other forever (docs/11, 2026-09-08).
   */
  relayed?: boolean;
  /**
   * How many turns this message is from a person (INV-1277): 0 when the sending turn was
   * opened by a person, else one more than the inbound that woke the sender. The bus refuses a
   * send past the budget, so two agents correcting each other's numbers stop and wait for
   * someone instead of running until their context is cut.
   */
  hops?: number;
  /**
   * This message, identified, so both ends can point at the same thing.
   *
   * Ordering is not the hard part here and a logical clock would be machinery for a problem this
   * system does not have: every agent runs in one process against one clock, so timestamps already
   * put events in order. What was missing is the *link* — a turn recorded no trace of which message
   * caused it, and a sent message recorded no trace of which turn sent it, so "who caused this"
   * could not be walked backwards however precisely everything was timed. The moment there are two
   * orchestrators this stops being enough and a real clock is needed; it is not enough now for the
   * reason stated, not by accident.
   */
  id: string;
  /**
   * Its handle in the durable inbox, so the turn that takes it can mark it started.
   *
   * Absent only when no inbox is configured. A configured inbox must persist admission
   * before the caller receives success.
   */
  admission?: number;
  /**
   * Which conversation this belongs to. Absent means the main one — the team room —
   * which is where every teammate and system message goes: agents talk to each other
   * in the room, not inside somebody's Telegram thread. Rides inside the message so
   * the durable inbox persists it for free.
   */
  conversation?: string;
  /**
   * Whether a running turn may consume this as mid-turn steering. Absent means yes
   * for a user message. False is for kickoffs that must open their own turn whatever
   * is running — a scheduled skill, a resume prompt — where absorption into someone
   * else's task would bury the report inside an unrelated reply.
   */
  steerable?: boolean;
  /**
   * Which class of work this is, which decides what waits for what.
   *
   * A person asking a question and a nightly digest firing are not the same urgency,
   * and until they were told apart the digest could take the conversation's worker for
   * minutes while the person watched a card sit still. Absent is inferred from the
   * sender: `user` for a person, `agent` for a teammate — so nothing has to be
   * declared to keep working, and the machinery that *is* background (a schedule, an
   * audit, a resume) says so.
   */
  lane?: Lane;
  /**
   * The harness started this turn, not a person — a timer, a webhook, a resume, a first run.
   *
   * It arrives as a message `fromId: "user"` because that is the shape that opens a turn, and
   * for a while that made every scheduled kickoff indistinguishable from somebody typing: the
   * webhook's own brief was drawn in the chat as the person's words, and the turn was treated
   * as one the person was waiting on.
   */
  synthetic?: boolean; /** Which part of the host wrote it, e.g. "host:audit" (INV-1571): never a person's words, whatever opened the turn. */ origin?: string;
  /**
   * A person said this in a room without addressing this agent (INV-775): a group message
   * that names nobody, on a door that runs every message. The turn is a person's, but nobody
   * is waiting on this agent in particular, so it may end in deliberate silence.
   */
  addressed?: false;
  /**
   * The tools a routine's own skill said it needs (INV-691). A turn opened only by messages that
   * carry one is offered what the agent has *and* the skill named — never more. Rides inside the
   * message so a routine resumed after a restart is held to the same list.
   */
  toolScope?: readonly string[];
  /**
   * A goal continuation (INV-770): the host woke the agent to keep working toward a pursuit.
   * The turn reads it for the workId it shares, writes its inbound entry as the host's, and
   * runs with no inner continuation; the goal loop decides at start whether it still applies.
   */
  goal?: GoalMarker;
  taskBinding?: TaskBinding;
}
