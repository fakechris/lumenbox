/**
 * Commands that hunt for this machine's credentials or probe the box's boundary (INV-1553).
 *
 * After INV-1543 closed the way in, four agents spent hours on their own audit work trying other
 * ways: reading the box daemon's token from /proc/1/environ with sudo, decrypting the box browser's
 * cookie jar, calling this machine's LumenBox UI with a forged Host and `x-agentbox-role: owner`,
 * and grepping logs and system directories for 64-hex tokens and `lmbx_` (2026-11-03). Every attempt
 * failed; nobody knew until a release investigation read the job list. This names those commands —
 * deterministically, from the text, no model — so the shell guard refuses them and a person hears.
 */

import { BOX_SIDE_HOSTS } from "../box/host-names.ts";

export type ProbeKind = "process-environment" | "browser-cookies" | "host-ui" | "identity-headers" | "credential-search";

export interface Probe {
  kind: ProbeKind;
  /** What it does, for the refusal and for the person. */
  detail: string;
}

const HOSTS = [...BOX_SIDE_HOSTS].map(name => name.replace(/\./g, "\\.")).join("|");
const RULES: { kind: ProbeKind; test: RegExp; detail: string }[] = [
  { kind: "process-environment", test: /\/proc\/(?:\d+|self|\*|\$[A-Za-z_]+|[^\s/]*)\/environ\b/, detail: "reads a process's environment, where the box keeps its credentials" },
  { kind: "browser-cookies", test: /\b(?:peanuts|saltysalt)\b|\bCookies\b[^\n]*\bencrypted_value\b|\bencrypted_value\b[^\n]*\bCookies\b/, detail: "decrypts the browser's stored cookies" },
  { kind: "identity-headers", test: /\bx-agentbox-(?:user|role)\b/i, detail: "claims an identity with the gateway's headers" },
  { kind: "host-ui", test: new RegExp(`\\b(?:${HOSTS})(?::\\d+)?(?!\\S*\\/mcp\\/r\\/[0-9a-f]{32})(?:[/:?\\s"']|$)`), detail: "calls this machine's LumenBox from the box" },
  { kind: "credential-search", test: /\b(?:grep|rg|ag|ack|egrep|strings|find)\b[^\n|;]*(?:\[0-9a-f\]\{(?:32|40|64)\}|\[0-9a-fA-F\]\{(?:32|40|64)\}|lmbx_|ui-token|agentbox_ui|BOXD_TOKEN|AGENTBOX_UI_TOKEN)/, detail: "searches files for credentials" },
];

/** The first probe a command makes, or undefined for an ordinary command. */
export function probeOf(command: string): Probe | undefined {
  for (const rule of RULES) if (rule.test.test(command)) return { kind: rule.kind, detail: rule.detail };
  return undefined;
}

/** What the agent is told: refused, and why it is a person's call. */
export function probeRefusal(probe: Probe): string {
  return `Refused: this command ${probe.detail}. Reaching for this machine's credentials or around the box's boundary is not something an agent decides; ` +
    "the people who run this installation have been told. Do the work through your tools, or ask a person for what you need.";
}

export interface ProbeIncident {
  agentId: string;
  agentName: string;
  kind: ProbeKind;
  detail: string;
  at: string;
  count: number;
  paused: boolean;
}

const WINDOW_MS = 60 * 60_000;
const PAUSE_AT = 3;

/**
 * Counts probes per agent in a sliding hour: every one is said to admins; the third pauses the agent
 * (INV-1554's pause, which a person lifts). Keeps the recent incidents for the "needs you" list.
 */
export class ProbeKeeper {
  private readonly seen = new Map<string, number[]>();
  private readonly incidents: ProbeIncident[] = [];

  constructor(private readonly deps: {
    nameOf: (agentId: string) => string;
    notify: (text: string) => void;
    pause: (agentId: string, reason: string) => Promise<unknown>;
    isPaused: (agentId: string) => boolean;
    log: (line: string) => void;
    now?: () => number;
  }) {}

  async report(agentId: string, probe: Probe): Promise<ProbeIncident> {
    const now = this.deps.now?.() ?? Date.now();
    const recent = (this.seen.get(agentId) ?? []).filter(at => now - at < WINDOW_MS).concat(now);
    this.seen.set(agentId, recent);
    const name = this.deps.nameOf(agentId);
    const pause = recent.length >= PAUSE_AT && !this.deps.isPaused(agentId);
    if (pause) await this.deps.pause(agentId, `${recent.length} attempts in an hour to reach this machine's credentials or past the box's boundary`);
    const incident: ProbeIncident = { agentId, agentName: name, kind: probe.kind, detail: probe.detail, at: new Date(now).toISOString(), count: recent.length, paused: pause };
    this.incidents.unshift(incident);
    this.incidents.length = Math.min(this.incidents.length, 20);
    this.deps.log(`boundary probe: ${name} (${probe.kind}), ${recent.length} in the last hour${pause ? "; paused" : ""}`);
    this.deps.notify(`${name} tried a command that ${probe.detail}; it was refused.` + (pause ? ` That is ${recent.length} in an hour, so ${name} is paused until someone resumes them in Settings → Team.` : ""));
    return incident;
  }

  /** The newest incident per agent from the last day, for the "needs you" list. */
  recent(now: number = this.deps.now?.() ?? Date.now()): ProbeIncident[] {
    const seen = new Set<string>();
    return this.incidents.filter(incident => now - Date.parse(incident.at) < 24 * 3_600_000 && !seen.has(incident.agentId) && seen.add(incident.agentId) !== undefined);
  }
}
