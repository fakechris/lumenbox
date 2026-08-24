/**
 * Presets: somebody else's engine, installed as one capability.
 *
 * The turn engine here is a coordinator — channels, organisation, evidence, and
 * middleweight work. It is deliberately not a deep coding harness, because that is ten
 * engineer-years somebody else has already spent, and winning that race would not be
 * worth having. So the answer for "read this repository and make the tests pass" is to
 * hand it to an engine built for exactly that, and stay the thing that decides, meters
 * and records.
 *
 * A preset is that engine as a unit with five faces, and each is a decision:
 *
 *   - **Packaging.** The engine and its dependencies are a versioned part of the box.
 *     Pinned, never `latest`: an engine that silently upgrades under a running
 *     installation changes what every delegated task does, and the first anyone hears
 *     of it is different results. Upgrading is an explicit act.
 *   - **Interface.** Upward, exactly one tool. Mirroring an engine's own thirty tools
 *     into our list would hand it the orchestration, and the orchestration is the part
 *     we keep: our agent is the one that decides, the preset is the one that works.
 *   - **Skills.** The box's skills directory is projected where the engine looks for
 *     it, so a method written once is available to whoever executes it.
 *   - **Metering.** The engine's model traffic is pointed at the relay, so the key
 *     stays outside the box and every token it spends lands in the same usage log as
 *     ours — under the same per-person budget, the same audit.
 *   - **Acceptance.** A preset carries the golden tasks that prove it still works, so
 *     an upgrade or a provider change is re-checked rather than assumed.
 *
 * This file owns the first four as data and the fifth as a name. Nothing here spawns
 * anything: the running is `bash background: true` and `Jobs`, which is what makes a
 * delegated engine visible, interruptible and loggable exactly like any other job.
 */

export interface Preset {
  /** What an agent names in the Delegate tool. */
  name: string;
  /** One line, in the tool description, so a model can pick between presets. */
  summary: string;
  /** How to check it is installed. Non-zero means not there. */
  probe: string;
  /**
   * The command, given the prompt already shell-quoted.
   *
   * Non-interactive by construction: a delegated engine that stops to ask a question
   * would hang a job nobody is watching. v1 is deliberately one-shot; a session
   * protocol (ACP) is the upgrade, and it changes this line and nothing else.
   */
  run: (quotedPrompt: string) => string;
  /**
   * Where this engine looks for reusable methods, if it does. The box's own skills
   * directory is linked here at install.
   */
  skillsMount?: string;
  /** Environment that points the engine's model traffic at our relay. */
  relayEnv: (baseUrl: string, token: string) => Record<string, string>;
}

/**
 * The presets this box knows how to drive.
 *
 * opencode first, because it is the one whose non-interactive run is a documented
 * single command today and whose session protocol is native for the v2. Others follow
 * the same shape or they are not presets.
 */
export const PRESETS: readonly Preset[] = [
  {
    name: "opencode",
    summary: "A coding agent: reads a repository, edits files, runs tests, iterates.",
    probe: "command -v opencode",
    run: quoted => `opencode run ${quoted}`,
    skillsMount: "~/.config/opencode/skill",
    relayEnv: (baseUrl, token) => ({
      OPENAI_BASE_URL: baseUrl,
      OPENAI_API_KEY: token,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: token,
    }),
  },
  {
    name: "claude",
    summary: "Claude Code: the same shape, for repositories it already knows well.",
    probe: "command -v claude",
    run: quoted => `claude -p ${quoted}`,
    skillsMount: "~/.claude/skills",
    relayEnv: (baseUrl, token) => ({
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: token,
    }),
  },
];

export function presetNamed(name: string): Preset | undefined {
  return PRESETS.find(preset => preset.name === name);
}

/** Single-quoted for `bash -lc`, which is how every delegated prompt travels. */
export function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The environment a delegated run gets: the relay, and nothing else of ours.
 *
 * Empty when no relay is configured, and that is the honest default — without one the
 * engine has no credential, says so, and the alternative (handing it ours) is the one
 * thing the vault exists to prevent.
 */
export function delegateEnv(preset: Preset): Record<string, string> {
  const baseUrl = process.env.AGENTBOX_RELAY_URL;
  const token = process.env.AGENTBOX_RELAY_TOKEN;
  if (baseUrl === undefined || baseUrl === "" || token === undefined || token === "") return {};
  return preset.relayEnv(baseUrl, token);
}
