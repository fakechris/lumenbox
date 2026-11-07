/**
 * The Settings dialog's panes (INV-1660): one entry each — the key every field carries as
 * `data-settab`, the title on its tab, what it is for, and what it reads and writes (the
 * config.json keys and the API routes behind it).
 *
 * The tabs used to be literal anchors in settings-dialog-html.ts, and a script-mounted pane
 * (Supervision) wrote its own; a pane's name was whatever each place last typed. Now the dialog
 * renders its tab row from this list, a pane mounted by a script takes its title from here,
 * `docs/manual/reference-settings.md` is generated from it, and architecture-guard fails a
 * `data-settab` key that is not listed or a tab anchor written anywhere else.
 */

export interface SettingsPane {
  key: string;
  title: string;
  /** The title in Chinese: the page reads it in the person's language (INV-1684). */
  titleZh: string;
  /** One sentence: what a person comes to this pane for. */
  about: string;
  aboutZh: string;
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
    titleZh: "模型",
    about: "The model provider, its model and key, the web search key, fallbacks when the plan runs out, the decision model and the built-in prompt parts.",
    aboutZh: "模型 provider、模型和它的 key、联网搜索 key、额度用完时的备用 provider、决策模型，以及内置的提示词。",
    config: ["provider", "model", "baseUrl", "fallbackProviders", "env"],
    apis: ["/api/config", "/api/config/test", "/api/prompt-parts", "/api/provider/fallbacks", "/api/provider/rests", "/api/jev"],
    mounted: "page",
  },
  {
    key: "boxes",
    title: "Boxes",
    titleZh: "Box",
    about: "The box and every machine attached to it, personal-box limits, host execution, the startup item, box image updates, resource diagnostics, and an organisation's nodes.",
    aboutZh: "这台 box 和接入的每台机器、个人 box 限额、在本机执行命令、开机启动、box 镜像更新、资源诊断，以及组织的节点。",
    config: ["boxImage", "boxCpus", "boxes", "personalBoxQuota", "personBoxQuotas", "departmentBoxQuotas", "hostExec", "startupItem", "upgradeHour"],
    apis: ["/api/box/up", "/api/boxes", "/api/quotas", "/api/directories", "/api/box/image", "/api/diagnostics/resources", "/api/nodes"],
    mounted: "page",
  },
  {
    key: "doors",
    title: "Channels",
    titleZh: "渠道",
    about: "The channels that open into this installation, the connectors linked to it, and the people waiting to be let in.",
    aboutZh: "通往这个安装的渠道、接入的连接器，以及在等着被放进来的人。",
    config: ["channelAllow"],
    apis: ["/api/channels", "/api/connectors"],
    mounted: "page",
  },
  {
    key: "team",
    title: "Team",
    titleZh: "团队",
    about: "Scopes, secrets, people and invites, MCP servers, and the team's limits: paused agents, push budgets, spend limits, routines that keep failing, shared-memory review.",
    aboutZh: "权限范围、密钥、人员与邀请、MCP 服务器，以及团队的各项上限：暂停的 agent、推送额度、花费上限、反复失败的例行任务、共享记忆审核。",
    config: ["mcpServers", "teamMemoryReview"],
    apis: ["/api/scopes", "/api/vault", "/api/principals", "/api/mcp", "/api/extensions/reload", "/api/agents/pauses", "/api/agents/push-budget", "/api/agents/spend-limits", "/api/schedules/runs", "/api/memory/team-review"],
    mounted: "page",
  },
  {
    key: "mine",
    title: "Mine",
    titleZh: "我的",
    about: "What is yours: your MCP tokens, your standing approvals, what the gate would have asked you, and what agents know about you.",
    aboutZh: "属于你的东西：你的 MCP token、你的长期批准、闸门本会问你的事，以及 agent 对你的了解。",
    config: [],
    apis: ["/api/mcp/tokens", "/api/policy", "/api/person"],
    mounted: "page",
  },
  {
    key: "memory",
    title: "Memory",
    titleZh: "记忆",
    about: "What each agent remembers, where each memory came from, and changing or removing it; what is proposed for the organisation's knowledge, and approving it.",
    aboutZh: "每个 agent 记住了什么、每条记忆从哪里来，以及修改或删除它；提议写入组织知识的内容，以及批准它。",
    config: [],
    apis: ["/api/memory", "/api/org-knowledge"],
    mounted: "page",
  },
  {
    key: "supervision",
    title: "Supervision",
    titleZh: "监督",
    about: "The watchdog that flags work which stops moving, and the supervisor you can give a goal to watch through to the end.",
    aboutZh: "看门狗：工作停滞时提醒你；监督者：你给它一个目标，它一直盯到结束。",
    config: [],
    apis: ["/api/supervision"],
    mounted: "script",
  },
  {
    key: "machine",
    title: "This machine",
    titleZh: "本机",
    about: "What this machine is for — personal machine, personal + organisation, or organisation node — chosen on the first run; switch between the first two by joining or disconnecting organisations. Only in the desktop app; kept in the app's own data, not in ~/.agentbox.",
    aboutZh: "这台机器的用途——个人的机器、个人 + 组织或组织的节点——在首次运行时选择；前两种之间靠加入或断开组织切换。只在桌面 app 里有；记录在 app 自己的数据目录，不在 ~/.agentbox。",
    config: [],
    apis: [],
    mounted: "script",
  },
  {
    key: "guests",
    title: "Guests",
    titleZh: "访客",
    about: "On an organisation only: every answer an agent gave a guest in a group chat, by group chat, agent and time, with the review's verdict — answers that promise something on the organisation's behalf or say what the knowledge does not are flagged red — the answers held for an Admin to approve, and which group chats review before sending. Who answers guests and the knowledge collections are in Team.",
    aboutZh: "只在组织里有：agent 在群里给访客的每一条回答，可按群、agent、时间查看，附审查结论——替组织许诺或说了知识里没有的内容会标红；等管理员批准的回答；以及哪些群先审后发。谁回答访客和知识集在「团队」里设置。",
    config: [],
    apis: ["/api/guests", "/api/guests/audit"],
    mounted: "script",
  },
  {
    key: "organisations",
    title: "Organisations",
    titleZh: "组织",
    about: "The organisations this app is connected to, beside the personal installation: join one by its address or an invite link, open it, disconnect. Each one is also an entry in the column at the window's left edge, with your role there and its own counts; opening it shows the organisation's own page in this window. Only in the desktop app; each organisation's token is kept in the system keychain.",
    aboutZh: "这个 app 在个人安装之外连接的组织：用地址或邀请链接加入、打开、断开。每个组织也是窗口最左一栏里的一项，显示你在那里的角色和它自己的计数；打开后在这个窗口里显示组织自己的页面。只在桌面 app 里有；每个组织的令牌存在系统钥匙串里。",
    config: [],
    apis: [],
    mounted: "script",
  },
];

export function settingsPane(key: string): SettingsPane {
  const pane = SETTINGS_PANES.find(p => p.key === key);
  if (pane === undefined) throw new Error(`no settings pane ${key}`);
  return pane;
}

/** The dialog's tab row: the panes in the markup, the first one on, each title a bundle key (`ui.pane.<key>`). */
export function renderSettingsTabs(): string {
  return SETTINGS_PANES.filter(pane => pane.mounted === "page")
    .map((pane, i) => `      <a href="#" class="tab${i === 0 ? " on" : ""}" data-settab="${pane.key}">{{ui.pane.${pane.key}}}</a>`)
    .join("\n");
}
