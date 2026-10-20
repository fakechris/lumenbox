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
 *   - **Metering.** `relayEnv` points the engine's model traffic at a relay, so the
 *     provider's key stays outside the box. Two paths, and the operator's wins:
 *     with `AGENTBOX_RELAY_URL` and `AGENTBOX_RELAY_TOKEN` both set, `delegateEnv`
 *     hands the engine that external relay as-is (nothing here meters it). With them
 *     unset, Delegate asks the host's own relay (model-relay.ts) to mint a route for
 *     this one job — a bearer good only for that route, leased while it is used — and
 *     the real key is attached on the host side when the bytes are forwarded
 *     (tools.ts, the `modelRelay.mint` branch). That relay reads the provider's
 *     stream as it passes only to count tokens, and records each call as a `delegate`
 *     row in usage.jsonl with the agent, work and job on it. An attached box cannot
 *     reach the host, so it gets no route and is told so. Setting exactly one of the
 *     two variables is the misconfiguration absences.ts reports at startup.
 *   - **Acceptance.** A preset carries the golden tasks that prove it still works, so
 *     an upgrade or a provider change is re-checked rather than assumed.
 *
 * This file owns the first four as data and the fifth as a name. Nothing here spawns
 * anything: the running is `bash background: true` and `Jobs`, which is what makes a
 * delegated engine visible, interruptible and loggable exactly like any other job.
 */

/**
 * The flag that makes each engine write its machine-readable stream, from which the host reads
 * the engine's own completion report (INV-908, engine-report.ts).
 */
export const MACHINE_OUTPUT: Readonly<Record<"claude" | "pi" | "opencode" | "mcode", string>> = {
  claude: "--output-format stream-json --verbose",
  pi: "--mode json",
  opencode: "--format json",
  mcode: "--output-format stream-json",
};

/**
 * Where an engine installed on demand lives: on the work volume, so it survives a box
 * rebuild, under a prefix of its own so nothing else in the box depends on it. The
 * image's own layer (when a version was named at build) is found first on PATH; this is
 * the fallback the person chose at use time.
 */
export const ENGINES_DIR = "/home/box/work/.lumenbox/engines";
export const ENGINES_BIN = `${ENGINES_DIR}/bin`;

/** A command with the on-demand engines on its PATH, ahead of nothing the image ships. */
export function withEnginesPath(command: string): string {
  return `export PATH="$PATH:${ENGINES_BIN}"; ${command}`;
}

export interface Preset {
  /** What an agent names in the Delegate tool. */
  name: string;
  /**
   * How to put it in the box when the person wants it and the image does not carry it.
   * Pinned, like the image layer: the version is the preset's, not npm's latest, so two
   * boxes that chose the same engine run the same engine. Installed under ENGINES_DIR.
   */
  install: {
    package: string;
    version: string;
    ignoreScripts?: boolean;
    /** Run after the install, as the box user: skills links and the like. */
    after?: string;
  };
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
   * protocol (ACP) is the upgrade, and it changes this line and nothing else. What that
   * upgrade is, measured on mcode's ACP, is docs/81 (INV-1234): a session per delegation,
   * permission questions to the policy gate, steer and cancel as the engine's own calls.
   */
  run: (quotedPrompt: string, model?: string, extraArgs?: string) => string;
  /**
   * Where this engine looks for reusable methods, if it does. The box's own skills
   * directory is linked here at install.
   */
  skillsMount?: string;
  /** Environment that points the engine's model traffic at our relay, and names the model where the engine reads one. */
  relayEnv: (baseUrl: string, token: string, model?: string) => Record<string, string>;
  /**
   * The session form (docs/81): the command that runs the engine's ACP surface on its stdio,
   * for boxd to keep alive and the host to speak to. Absent for engines without one; the
   * one-shot `run` stays the whole story for them.
   */
  acp?: { command: (model?: string) => string };
  /**
   * The wires this engine can speak to a model over. The built-in relay forwards bytes as
   * sent, so an engine that only speaks Anthropic's API cannot be pointed at an OpenAI-wire
   * provider through it; the Delegate tool checks this and says so instead of starting a run
   * that fails on its first call.
   */
  wires: readonly ("anthropic" | "openai")[];
  /**
   * A config file some engines need before a relay URL means anything to them (pi's
   * models.json, opencode's provider catalog). Written into the box before the job starts,
   * with the token as an environment reference, never inline.
   */
  relayConfig?: (
    url: string,
    tokenVar: string,
    wire: "anthropic" | "openai",
    model: string
  ) => { file: string; content: string; env: Record<string, string> };
  /**
   * The command-line fragment that routes the engine's permission prompts to the host's face
   * (Claude Code's `--permission-prompt-tool`), when the engine has one. With it the run does
   * not skip permissions; without a face the run falls back to skipping them, said out loud.
   */
  permissionArgs?: string;
  /** The fragment that opens or resumes the engine's own thread under a capsule id. */
  session?: (id: string, resumed: boolean) => string;
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
const PRESETS_MUTABLE: Preset[] = [
  // Filled below; the pi preset is appended after the definitions it refers to.
];
export const PRESETS: readonly Preset[] = PRESETS_MUTABLE;
PRESETS_MUTABLE.push(...([
  {
    name: "opencode",
    summary: "A coding agent: reads a repository, edits files, runs tests, iterates.",
    probe: "command -v opencode",
    install: {
      package: "opencode-ai",
      version: "1.18.25",
      after: "mkdir -p ~/.config/opencode && ln -sfn /home/box/work/skills ~/.config/opencode/skill",
    },
    // --auto, because a headless `opencode run` auto-rejects every tool permission
    // without it — the engine "works" and does nothing. The box is the sandbox; the
    // permission prompt has no one to ask. The model travels as a flag because this
    // engine has no model environment variable (measured on 1.18.25).
    run: (quoted, model, extraArgs) =>
      `opencode run --auto ${MACHINE_OUTPUT.opencode}${model ? ` -m ${model}` : ""}${extraArgs ? ` ${extraArgs}` : ""} ${quoted}`,
    skillsMount: "~/.config/opencode/skill",
    wires: ["anthropic", "openai"],
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
    install: {
      package: "@anthropic-ai/claude-code",
      version: "2.1.250",
      after: "mkdir -p ~/.claude && ln -sfn /home/box/work/skills ~/.claude/skills",
    },
    // The same headless truth as opencode's --auto, in this engine's dialect; inside
    // the box the sandbox is the container, not the prompt. Untested until a claude
    // build ships in an image — says so in docs/25.
    run: (quoted, model, extraArgs) =>
      `claude -p ${MACHINE_OUTPUT.claude}${extraArgs?.includes("--permission-prompt-tool") ? "" : " --dangerously-skip-permissions"}` +
      `${model ? ` --model ${model}` : ""}${extraArgs ? ` ${extraArgs}` : ""} ${quoted}`,
    permissionArgs: "--permission-prompt-tool mcp__lumenbox__permission",
    session: (id, resumed) => (resumed ? `--resume ${id}` : `--session-id ${id}`),
    skillsMount: "~/.claude/skills",
    wires: ["anthropic"],
    // Claude Code's runtime is its environment: where the model is, which key, which model,
    // where its own state lives. All of it is set per run, none of it persists in the box.
    relayEnv: (baseUrl, token, model) => ({
      ANTHROPIC_BASE_URL: baseUrl,
      // The bearer form: what a compatible endpoint (MiniMax's /anthropic, and the relay
      // in front of it) expects, and what Chris runs Claude Code with by hand.
      ANTHROPIC_AUTH_TOKEN: token,
      ...(model !== undefined ? { ANTHROPIC_MODEL: model } : {}),
      CLAUDE_CONFIG_DIR: "/home/box/.claude",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
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
] as Preset[]));

export const PI_MODELS_FILE = "/home/box/.pi/agent/models.json";

PRESETS_MUTABLE.push({
  name: "pi",
  summary: "pi: a small coding agent with sessions and skills; good for scoped edits and scripts.",
  probe: "command -v pi",
  install: {
    package: "@earendil-works/pi-coding-agent",
    version: "0.85.1",
    ignoreScripts: true,
    after: "mkdir -p ~/.pi/agent && ln -sfn /home/box/work/skills ~/.pi/agent/skills",
  },
  // -p prints and exits; --no-session keeps a one-shot run out of pi's session store;
  // --approve trusts the project's own skills and extensions, since the box is the sandbox.
  // The provider is the relay's entry in models.json (relayConfig), so the model is named
  // as `lumenbox/<id>`. Measured on 0.85.1 (README and docs/models.md).
  run: (quoted, model, extraArgs) =>
    `pi -p --no-session --approve ${MACHINE_OUTPUT.pi}${model ? ` --model ${quoteForShell(`lumenbox/${model}`)}` : ""}${extraArgs ? ` ${extraArgs}` : ""} ${quoted}`,
  skillsMount: "~/.pi/agent/skills",
  wires: ["anthropic", "openai"],
  // pi reads no BASE_URL variables; its providers come from models.json (below). The token
  // still travels in the environment, which the file references as `$VAR`.
  relayEnv: (_baseUrl, token) => ({ LUMENBOX_RELAY_TOKEN: token }),
  relayConfig: (url, _tokenVar, wire, model) => ({
    file: PI_MODELS_FILE,
    content: `${JSON.stringify(
      {
        providers: {
          lumenbox: {
            baseUrl: url,
            api: wire === "openai" ? "openai-completions" : "anthropic-messages",
            apiKey: "$LUMENBOX_RELAY_TOKEN",
            models: [{ id: model }],
          },
        },
      },
      null,
      2
    )}\n`,
    env: {},
  }),
  // pi has no MCP client (its README says so, and why). The face file is still written, as
  // a note the engine can read, so a lent tool is at least named where the run looks.
  mcpFace: (url, tokenVar) => ({
    content: `${JSON.stringify(
      { note: "pi cannot call MCP servers; these host tools were offered but are unreachable from pi", url, token: `$${tokenVar}` },
      null,
      2
    )}\n`,
    env: {},
    args: "",
    note: "pi has no MCP client; lend it tools as CLI scripts in the box instead",
  }),
});

/** How many model steps one mcode delegation may take before the engine stops it (exit 7, reported as `limit_exceeded`). */
export const MCODE_MAX_STEPS = 200;

/**
 * The profile an mcode run is given: written by the run itself, from its environment, into a
 * directory that exists only for that run.
 *
 * mcode reads its provider from `config.yaml` in its data directory and expands no variables
 * there, so the relay token would have to sit in that file in plain text. The way out is to
 * give each run a data directory of its own (`MINIMAX_DATA_DIR` to a `mktemp -d`), write the
 * file there from `$LUMENBOX_RELAY_TOKEN` at the last moment, and remove the directory when
 * the run ends however it ends (`trap … EXIT`): nothing with the token outlives the job, and
 * the route it names is revoked at job end anyway. The file also carries the engine's goal
 * verification, which for a custom provider defaults to `none` — the worker's own word that it
 * finished — and must be `subagent` here (INV-1232, verification-policy.ts). Read from
 * minimax-code 9a93560 / 0.6.12; the permission policy is on the command line below.
 */
function mcodeProfileShell(model: string | undefined, permissionMode?: "default"): string {
  const id = model !== undefined ? quoteForShell(model) : '"${LUMENBOX_RELAY_MODEL:?mcode needs a model name}"';
  // The session form names its permission policy in the profile (there is no flag for `acp`):
  // `default` is Ask, which is what routes the question to this host. Never the engine's own
  // default, `auto`, which classifies in MiniMax's cloud (docs/81 §1).
  const mode = permissionMode !== undefined ? `permissionMode: ${permissionMode}\\n` : "";
  return (
    `d=$(mktemp -d /tmp/mcode.XXXXXX) && trap 'rm -rf "$d"' EXIT && umask 077 && m=${id} && ` +
    `printf 'custom_provider:\\n  lumenbox:\\n    api: %s\\n    options:\\n      apiKey: %s\\n      baseURL: %s\\n    models:\\n      %s: {}\\ndefaultModel: custom_provider:lumenbox/%s\\n${mode}goal:\\n  verification: subagent\\n' ` +
    `"\${LUMENBOX_RELAY_API:-anthropic-messages}" "\${LUMENBOX_RELAY_TOKEN:?mcode needs the relay token}" "\${LUMENBOX_RELAY_URL:?mcode needs the relay url}" "$m" "$m" > "$d/config.yaml" && ` +
    `export MINIMAX_DATA_DIR="$d"`
  );
}

PRESETS_MUTABLE.push({
  name: "mcode",
  summary: "MiniMax Code: MiniMax's own coding agent, tuned for the M3 family; explore / worker / verifier sub-agents, strict about finishing.",
  probe: "command -v mcode",
  // Not --ignore-scripts: the engine needs better-sqlite3's native binding, which its install
  // fetches as a prebuilt. Needs Node 22.19+ in the box (0.6.x refuses older, exit 1).
  install: {
    package: "@minimax-ai/code",
    version: "0.6.12",
    after: "mkdir -p ~/.agents && ln -sfn /home/box/work/skills ~/.agents/skills",
  },
  // `exec` is the one-shot surface: no prompts, no login for a custom provider, and an
  // interaction it would have needed fails the run instead of hanging it. `--permission full`
  // is not optional: the default, `smart`, sends every tool input the local rules cannot decide
  // to MiniMax's cloud gateway (permission/src/cloud-gateway.ts), key or no key. The box is the
  // sandbox; the prompt has no one to ask. `--max-steps` is the budget; the engine reports
  // `limit_exceeded` when it is reached. The model is the relay's entry, named as
  // `custom_provider:lumenbox/<id>`, and travels as a flag as well as in the profile.
  run: (quoted, model, extraArgs) =>
    `${mcodeProfileShell(model)} && mcode exec --config "$d/config.yaml" ${MACHINE_OUTPUT.mcode} --permission full --max-steps ${MCODE_MAX_STEPS}` +
    ` --model "custom_provider:lumenbox/$m"${extraArgs ? ` ${extraArgs}` : ""} ${quoted}`,
  // The session form: the same profile, Ask as the permission policy, and the engine's ACP
  // surface on its stdio for boxd to hold (docs/81). The model goes in the profile's
  // defaultModel; `mcode acp` has no --model flag.
  acp: { command: model => `${mcodeProfileShell(model, "default")} && mcode acp` },
  skillsMount: "~/.agents/skills",
  wires: ["anthropic", "openai"],
  // mcode reads no BASE_URL or API_KEY variables at all (bash-subprocess-env.ts scrubs them from
  // what it runs). The relay travels under our own names and becomes the profile at run time;
  // telemetry is off by both names it honours. Nothing here is a file in the box.
  relayEnv: (baseUrl, token, model) => ({
    LUMENBOX_RELAY_URL: baseUrl,
    LUMENBOX_RELAY_TOKEN: token,
    ...(model !== undefined ? { LUMENBOX_RELAY_MODEL: model } : {}),
    MCODE_DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
  }),
  // The wire is decided on the host; the run writes it into the profile. The file written here
  // is a note only (the real profile is per run, see mcodeProfileShell) and names no secret.
  relayConfig: (url, tokenVar, wire) => ({
    file: "/home/box/.agents/mcode-relay.json",
    content: `${JSON.stringify(
      { note: "mcode's profile is written per run from the environment into a temporary MINIMAX_DATA_DIR; this file only records the route", url, token: `$${tokenVar}`, api: wire === "openai" ? "openai-completions" : "anthropic-messages" },
      null,
      2
    )}\n`,
    env: { LUMENBOX_RELAY_API: wire === "openai" ? "openai-completions" : "anthropic-messages" },
  }),
  // mcode has an MCP client, but its servers are configured in the same profile file; lending
  // tools through it is the ACP step (INV-1234), not this one-shot preset.
  mcpFace: (url, tokenVar) => ({
    content: `${JSON.stringify(
      { note: "this one-shot mcode preset does not load MCP servers; the host tools below were offered but are not reachable from it", url, token: `$${tokenVar}` },
      null,
      2
    )}\n`,
    env: {},
    args: "",
    note: "mcode is run one-shot without MCP servers here; lend it tools as CLI scripts in the box instead",
  }),
});

/** The one-line install for a preset, as `bash -lc` runs it in the box. */
export function installCommand(preset: Preset): string {
  const { package: pkg, version, ignoreScripts, after } = preset.install;
  return (
    `mkdir -p ${ENGINES_DIR} && npm install -g --prefix ${ENGINES_DIR}${ignoreScripts ? " --ignore-scripts" : ""} ` +
    `${quoteForShell(`${pkg}@${version}`)}` +
    (after !== undefined ? ` && ${after}` : "") +
    ` && echo "installed ${preset.name} ${version} under ${ENGINES_DIR}"`
  );
}

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
