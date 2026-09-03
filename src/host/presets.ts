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
 *   - **Metering.** The *seam* for it: `relayEnv` points the engine's model traffic at
 *     whatever relay the two environment variables below name, so the key can stay
 *     outside the box. Nothing in this repository provides that relay yet — the egress
 *     relay forwards bytes and never parses traffic, so it cannot substitute a key or
 *     count a token — and with the variables unset `delegateEnv` returns `{}` and the
 *     engine has no credential at all. Honest, and loud at startup (see absences.ts),
 *     but not metering. This bullet described the destination as the present tense
 *     until docs/14 checked it.
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
   * The command, given the prompt already shell-quoted and, when the relay names one,
   * the model in this engine's own format (opencode says `provider/model`, others say
   * other things — the operator sets the variable to match the engine they operate).
   *
   * Non-interactive by construction: a delegated engine that stops to ask a question
   * would hang a job nobody is watching. v1 is deliberately one-shot; a session
   * protocol (ACP) is the upgrade, and it changes this line and nothing else.
   */
  run: (quotedPrompt: string, model?: string, extraArgs?: string) => string;
  /**
   * Where this engine looks for reusable methods, if it does. The box's own skills
   * directory is linked here at install.
   */
  skillsMount?: string;
  /** Environment that points the engine's model traffic at our relay. */
  relayEnv: (baseUrl: string, token: string) => Record<string, string>;
  /**
   * The sixth face (docs/33): the file, environment and command-line fragment that make this
   * engine talk to one remote MCP server — ours, on the host — and no other of ours. The token
   * travels in the environment under `tokenVar`, never in the file and never on the command
   * line; the file is written to `file` before the job starts.
   */
  mcpFace: (url: string, tokenVar: string, file: string) => {
    content: string;
    env: Record<string, string>;
    args: string;
    /** What the review found and the operator should know. */
    note?: string;
  };
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
    // --auto, because a headless `opencode run` auto-rejects every tool permission
    // without it — the engine "works" and does nothing. The box is the sandbox; the
    // permission prompt has no one to ask. The model travels as a flag because this
    // engine has no model environment variable (measured on 1.18.25).
    run: (quoted, model, extraArgs) =>
      `opencode run --auto${model ? ` -m ${model}` : ""}${extraArgs ? ` ${extraArgs}` : ""} ${quoted}`,
    skillsMount: "~/.config/opencode/skill",
    // Measured on 1.18.25: opencode ignores ANTHROPIC_BASE_URL/OPENAI_BASE_URL — its
    // endpoints come from a provider catalog, overridable only in its config file. The
    // BASE_URL pair stays for engine versions that do honor it; what actually routes
    // traffic today is MINIMAX_API_KEY, which lights up the catalog's minimax-cn
    // provider — the degenerate-relay case, where the relay variables name the vendor
    // itself. A true relay with its own URL needs the config-file face (docs/25).
    relayEnv: (baseUrl, token) => ({
      OPENAI_BASE_URL: baseUrl,
      OPENAI_API_KEY: token,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: token,
      MINIMAX_API_KEY: token,
    }),
    // opencode reads a config file named by OPENCODE_CONFIG and expands `{env:VAR}` in it; it
    // still merges its global config, so an operator's own MCP entries in the box would load
    // beside ours (our image ships none). `oauth: false` keeps it from trying a browser flow
    // against a route that answers 401 to anything but its bearer.
    mcpFace: (url, tokenVar, file) => ({
      content: `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            lumenbox: {
              type: "remote",
              url,
              headers: { Authorization: `Bearer {env:${tokenVar}}` },
              oauth: false,
            },
          },
        },
        null,
        2
      )}\n`,
      env: { OPENCODE_CONFIG: file },
      args: "",
      note: "opencode merges its global config too; only ours ships in the image",
    }),
  },
  {
    name: "claude",
    summary: "Claude Code: the same shape, for repositories it already knows well.",
    probe: "command -v claude",
    // The same headless truth as opencode's --auto, in this engine's dialect; inside
    // the box the sandbox is the container, not the prompt. Untested until a claude
    // build ships in an image — says so in docs/25.
    run: (quoted, model, extraArgs) =>
      `claude -p --dangerously-skip-permissions${model ? ` --model ${model}` : ""}${extraArgs ? ` ${extraArgs}` : ""} ${quoted}`,
    skillsMount: "~/.claude/skills",
    relayEnv: (baseUrl, token) => ({
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: token,
    }),
    // Claude Code expands `${VAR}` in MCP config, and `--strict-mcp-config` restricts it to the
    // servers given by `--mcp-config` — so the file must be *passed*, not merely present in the
    // working directory (the review's finding; the CLI reference agrees).
    mcpFace: (url, tokenVar, file) => ({
      content: `${JSON.stringify(
        {
          mcpServers: {
            lumenbox: { type: "http", url, headers: { Authorization: `Bearer \${${tokenVar}}` } },
          },
        },
        null,
        2
      )}\n`,
      env: {},
      args: `--mcp-config ${quoteForShell(file)} --strict-mcp-config`,
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
/** Where a delegated engine's model traffic goes. Named here so absences.ts and this file cannot drift. */
export const RELAY_URL_VARIABLE = "AGENTBOX_RELAY_URL";
export const RELAY_TOKEN_VARIABLE = "AGENTBOX_RELAY_TOKEN";
/**
 * The model a delegated engine should use, in that engine's own format. Optional: an
 * engine without one falls back to whatever it would pick alone, which for a fresh
 * install is usually a refusal to pick — so a configured relay wants this set too.
 */
export const RELAY_MODEL_VARIABLE = "AGENTBOX_RELAY_MODEL";

export function delegateEnv(preset: Preset): Record<string, string> {
  const baseUrl = process.env[RELAY_URL_VARIABLE];
  const token = process.env[RELAY_TOKEN_VARIABLE];
  if (baseUrl === undefined || baseUrl === "" || token === undefined || token === "") return {};
  return preset.relayEnv(baseUrl, token);
}

/** The relay's model choice, or undefined when the operator has not named one. */
export function delegateModel(): string | undefined {
  const model = process.env[RELAY_MODEL_VARIABLE];
  return model === undefined || model === "" ? undefined : model;
}
