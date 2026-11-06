/**
 * The Settings dialog's panes (INV-1660): one entry each — the key every field carries as
 * `data-settab`, the title on its tab, what it is for, and what it reads and writes (the
 * config.json keys and the API routes behind it).
 *
 * The tabs used to be literal anchors in settings-dialog-html.ts, and a script-mounted pane
 * (Supervision) wrote its own; a pane's name was whatever each place last typed. Now the dialog
 * renders its tab row from this list, a pane mounted by a script takes its title from here,
 * `docs/reference-settings.md` is generated from it, and architecture-guard fails a
 * `data-settab` key that is not listed or a tab anchor written anywhere else.
 */

export interface SettingsPane {
  key: string;
  title: string;
  /** One sentence: what a person comes to this pane for. */
  about: string;
  /** The `~/.agentbox/config.json` keys this pane edits; empty when it edits other stores. */
  config: readonly string[];
  /** The API routes the pane reads and writes. */
  apis: readonly string[];
  /** `page`: the tab is in the dialog's markup. `script`: a script mounts it when it loads. */
  mounted: "page" | "script";
}

export const SETTINGS_PANES: readonly SettingsPane[] = [
  {
    key: "model",
    title: "Model",
    about: "The model provider, its model and key, the web search key, fallbacks when the plan runs out, the decision model and the built-in prompt parts.",
    config: ["provider", "model", "baseUrl", "fallbackProviders", "env"],
    apis: ["/api/config", "/api/config/test", "/api/prompt-parts", "/api/provider/fallbacks", "/api/provider/rests", "/api/jev"],
    mounted: "page",
  },
  {
    key: "boxes",
    title: "Boxes",
    about: "The box and every machine attached to it, personal-box limits, host execution, the startup item, box image updates and resource diagnostics.",
    config: ["boxImage", "boxCpus", "boxes", "personalBoxQuota", "personBoxQuotas", "departmentBoxQuotas", "hostExec", "startupItem", "upgradeHour"],
    apis: ["/api/box/up", "/api/boxes", "/api/quotas", "/api/directories", "/api/box/image", "/api/diagnostics/resources"],
    mounted: "page",
  },
  {
    key: "doors",
    title: "Channels",
    about: "The channels that open into this installation, the connectors linked to it, and the people waiting to be let in.",
    config: ["channelAllow"],
    apis: ["/api/channels", "/api/connectors"],
    mounted: "page",
  },
  {
    key: "team",
    title: "Team",
    about: "Scopes, secrets, people and invites, MCP servers, and the team's limits: paused agents, push budgets, spend limits, routines that keep failing, shared-memory review.",
    config: ["mcpServers", "teamMemoryReview"],
    apis: ["/api/scopes", "/api/vault", "/api/principals", "/api/mcp", "/api/extensions/reload", "/api/agents/pauses", "/api/agents/push-budget", "/api/agents/spend-limits", "/api/schedules/runs", "/api/memory/team-review"],
    mounted: "page",
  },
  {
    key: "mine",
    title: "Mine",
    about: "What is yours: your MCP tokens, your standing approvals, what the gate would have asked you, and what agents know about you.",
    config: [],
    apis: ["/api/mcp/tokens", "/api/policy", "/api/person"],
    mounted: "page",
  },
  {
    key: "memory",
    title: "Memory",
    about: "What each agent remembers, where each memory came from, and changing or removing it.",
    config: [],
    apis: ["/api/memory"],
    mounted: "page",
  },
  {
    key: "supervision",
    title: "Supervision",
    about: "The watchdog that flags work which stops moving, and the supervisor you can give a goal to watch through to the end.",
    config: [],
    apis: ["/api/supervision"],
    mounted: "script",
  },
];

export function settingsPane(key: string): SettingsPane {
  const pane = SETTINGS_PANES.find(p => p.key === key);
  if (pane === undefined) throw new Error(`no settings pane ${key}`);
  return pane;
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The dialog's tab row: the panes in the markup, the first one on. */
export function renderSettingsTabs(): string {
  return SETTINGS_PANES.filter(pane => pane.mounted === "page")
    .map((pane, i) => `      <a href="#" class="tab${i === 0 ? " on" : ""}" data-settab="${pane.key}">${escapeHtml(pane.title)}</a>`)
    .join("\n");
}
