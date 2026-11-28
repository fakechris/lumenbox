/**
 * What the first screen shows, the same in both editions (INV-2311, docs/112 §3, §4): a heading per
 * sandbox the person may use, with one of four state words, and the getting-started list computed
 * from the person's state.
 *
 * Plain functions shipped to the page as their own source (as next-logic-ui.ts), so the test and the
 * page run the same code. They choose words and destinations; the page draws them and presses them.
 *
 * - A sandbox the person cannot use, or that cannot run here, has no heading (§3 rule 1): the server
 *   lists only the boxes a person may use (`/api/boxes`), and leaves out the installation's own box
 *   on Kubernetes (installation-box-here.ts).
 * - State words are four (§3 rule 3): preparing, ready, stopped, failed. *Failed* always carries a
 *   reason in a member's words (§3 rule 4: no internal word) and one action that works.
 * - Every step's action does the thing or opens the exact place where it is done (§3 rule 2). A step
 *   that cannot be done here is not on the list.
 */

/** A sandbox as `/api/boxes` lists it. */
interface SandboxRow { id: string; name: string; kind?: string; connected?: boolean; personal?: boolean; yours?: boolean }

/** What the page knows besides the list: whose installation, whose box is starting, why it did not. */
interface SandboxFacts {
  edition: string;
  admin: boolean;
  /** The installation's own box. */
  own: string;
  starting: boolean;
  /** Why the last start of the installation's own box failed, as Docker said it. */
  failed: string;
  /** Docker on this computer: `no-binary` (not installed) or `no-engine` (not running), when the own box is down. */
  docker: string;
  /** The person's own sandbox before it exists (`/api/setup` autoBox): being made, failed, or out of quota. */
  auto?: { state: string; reason?: string; id?: string };
}

/** What may be pressed for a sandbox that is not ready. */
type SandboxAct = "start" | "retry" | "docker" | "settings";

interface Sandbox { id: string; name: string; yours: boolean; state: string; reason?: string; detail?: string; act?: SandboxAct }

/** A failure as the cluster or the box daemon said it, in words a member can read: the detail stays on Settings → Computers. */
function sandboxReasonOf(raw: string | undefined): string {
  const said = String(raw ?? "");
  if (/image|pull/i.test(said)) return "download";
  if (/unschedulable|insufficient|resources|quota/i.test(said)) return "room";
  if (/unreachable|connect|refused|timed? ?out|health/i.test(said)) return "noAnswer";
  return "other";
}

/** The sandboxes the person has a heading for, theirs first, each with its state. */
function sandboxesOf(list: readonly SandboxRow[], facts: SandboxFacts): Sandbox[] {
  const shown = list.map(box => {
    const yours = !!box.yours || (facts.edition === "personal" && box.id === facts.own);
    const one: Sandbox = { id: box.id, name: box.name, yours, state: "ready" };
    if (box.connected) return one;
    if (box.id === facts.own && facts.starting) return { ...one, state: "preparing" };
    if (box.id === facts.own && facts.docker === "no-binary") return { ...one, state: "failed", reason: "noDocker", ...(facts.admin ? { act: "docker" as const } : {}) };
    if (box.id === facts.own && facts.docker === "no-engine") return { ...one, state: "failed", reason: "noEngine", ...(facts.admin ? { act: "start" as const } : {}) };
    if (box.id === facts.own && facts.failed) return { ...one, state: "failed", reason: "other", detail: facts.failed, ...(facts.admin ? { act: "start" as const } : {}) };
    if (box.id === facts.own) return { ...one, state: "stopped", ...(facts.admin ? { act: "start" as const } : {}) };
    // A person's own sandbox on the organisation's machines that does not answer: its owner tries the connection again from
    // here; an Admin looking at somebody else's has it on Settings → Computers, where its detail is.
    if (box.personal) return { ...one, state: "failed", reason: "noAnswer", ...(yours ? { act: "retry" as const } : facts.admin ? { act: "settings" as const } : {}) };
    return { ...one, state: "stopped" };
  });
  const auto = facts.auto;
  // Their own sandbox before it is in the list: being made, or failed with the button that starts it again.
  if (!shown.some(box => box.yours) && auto && (auto.state === "preparing" || auto.state === "failed")) {
    shown.unshift(auto.state === "preparing" ? { id: "", name: "", yours: true, state: "preparing" }
      : { id: auto.id ?? "", name: "", yours: true, state: "failed", reason: sandboxReasonOf(auto.reason), ...(auto.id ? { act: "retry" as const } : {}) });
  }
  return shown.filter(box => box.yours).concat(shown.filter(box => !box.yours));
}

/** Where a press leads: a Settings pane, a conversation, or the act itself. */
type Destination =
  | { pane: string } | { chat: string } | { start: true } | { retry: string } | { url: string } | { create: true } | { newAgent: true };

interface Step { key: string; done: boolean; words: string; vars?: Record<string, string>; state?: string; reason?: string; optional?: boolean; act?: { words: string; vars?: Record<string, string>; to: Destination } }

interface PersonState {
  admin: boolean;
  /** Whether a model is set; undefined when the server did not say. */
  key: boolean | undefined;
  /** Whether a chat channel is connected. */
  door: boolean;
  /** Their own sandbox, as sandboxesOf has it. */
  yours: Sandbox | undefined;
  /** No sandbox of theirs, and the quota leaves none to make. */
  quota: boolean;
  /** No sandbox of theirs, none being made, and they may make one here. */
  canCreate: boolean;
  /** The sandbox step has shown it ready once: it is not on the list again. */
  readyOnce: boolean;
  /** The agent to talk to: their home agent, else the first in their sandbox. */
  agent: { id: string; name: string } | undefined;
  /** Their agent's conversation has been opened once. */
  opened: boolean;
}

const DOCKER_DESKTOP = "https://www.docker.com/products/docker-desktop/";

/** What a failed or stopped sandbox offers, as a step's action. */
function sandboxActOf(box: Sandbox): Step["act"] {
  if (box.act === "docker") return { words: "ui.first.getDocker", to: { url: DOCKER_DESKTOP } };
  if (box.act === "settings") return { words: "ui.first.openComputers", to: { pane: "boxes" } };
  if (box.act === "retry") return { words: "ui.first.tryAgain", to: { retry: box.id } };
  if (box.act === "start") return { words: box.state === "stopped" ? "ui.first.startIt" : "ui.first.tryAgain", to: { start: true } };
  return undefined;
}

/** Getting started, the same list in both editions (docs/112 §4): model, your sandbox, your agent, a chat channel. */
function gettingStartedOf(person: PersonState): Step[] {
  const steps: Step[] = [];
  if (person.key === false) {
    steps.push(person.admin
      ? { key: "model", done: false, words: "ui.first.model.none", act: { words: "ui.first.model.choose", to: { pane: "model" } } }
      : { key: "model", done: false, words: "ui.first.model.member" });
  }
  const box = person.yours;
  if (!person.readyOnce || (box && box.state !== "ready")) {
    if (box) {
      const act = box.state === "ready" || box.state === "preparing" ? undefined : sandboxActOf(box);
      // Stopped with nothing to press here is not a step: the sidebar says it.
      if (box.state !== "stopped" || act) steps.push({ key: "sandbox", done: box.state === "ready", words: "ui.first.step.sandbox", state: box.state, ...(box.reason ? { reason: box.reason } : {}), ...(act ? { act } : {}) });
    } else if (person.quota) {
      steps.push({ key: "sandbox", done: false, words: "ui.first.sandbox.quota" });
    } else if (person.canCreate) {
      steps.push({ key: "sandbox", done: false, words: "ui.first.step.sandbox", act: { words: "ui.first.sandbox.create", to: { create: true } } });
    }
  }
  if (!person.opened) {
    if (person.agent) steps.push({ key: "agent", done: false, words: "ui.first.step.agent", act: { words: "ui.first.talkTo", vars: { name: person.agent.name }, to: { chat: person.agent.id } } });
    else if (box && box.state === "ready") steps.push({ key: "agent", done: false, words: "ui.first.step.agent", act: { words: "ui.first.addAgent", to: { newAgent: true } } });
  }
  if (person.admin && !person.door) steps.push({ key: "channel", done: false, optional: true, words: "ui.first.step.channel", act: { words: "ui.first.connectChannel", to: { pane: "doors" } } });
  return steps;
}

export const firstScreen = { sandboxReasonOf, sandboxesOf, sandboxActOf, gettingStartedOf };
export type { Destination, PersonState, Sandbox, SandboxFacts, SandboxRow, Step };

/** The same functions, as page source. The constant goes with them: a function's source does not carry what it closes over. */
export const FIRST_SCREEN_LOGIC_JS = [`var DOCKER_DESKTOP = ${JSON.stringify(DOCKER_DESKTOP)};`, ...[sandboxReasonOf, sandboxesOf, sandboxActOf, gettingStartedOf].map(fn => fn.toString())].join("\n");
