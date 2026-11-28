import { UI_WORK_MANAGEMENT } from "./ui-work-management.ts";
import { UI_TASK_FOCUS } from "./ui-task-focus.ts";
/**
 * One bundle for everything a person reads from this installation (INV-544).
 *
 * The chat strings were Chinese in `channels/strings.ts`; the page was English in
 * `web/app-html.ts`. Same person, same installation, two languages — and the tests pinned
 * the words, which is how it survived every UI pass.
 *
 * Flat dotted keys, not nested objects: a key is grep-able from either language's file
 * and from the call site, and a missing one is caught by the parity test rather than by
 * a person reading a screen with a raw key on it.
 *
 * `{name}` placeholders are filled by `tr`. Anything conditional — plurals, a clause that
 * only appears sometimes — is composed at the call site from two keys rather than encoded
 * in the string, because a message with branches inside it is a message a translator
 * cannot check.
 *
 * Only what a *person* reads. Not model output (it already answers in their language) and
 * not the technical body of a consent request, where translating a command or a path
 * would blur what is being approved.
 */

import { DEFAULT_LOCALE, type Locale } from "./locale.ts";
import { fillWords } from "./fill.ts";
import { UI_APP } from "./ui-app.ts";
import { UI_PAGE } from "./ui-page.ts";
import { UI_SECTIONS } from "./ui-sections.ts";
import { SERVER_ERRORS } from "./server-errors.ts";
import { UI_NEXT } from "./ui-next.ts"; import { UI_NEXT_LINE } from "./ui-next-line.ts"; import { UI_NEXT_PRESS } from "./ui-next-press.ts";
import { UI_PERSONAL_COMPUTERS } from "./ui-personal-computers.ts"; import { UI_FIRST_SCREEN } from "./ui-first-screen.ts"; import { UI_DIRECTORY } from "./ui-directory.ts"; import { UI_ORG_SKILLS } from "./ui-org-skills.ts";
import { SERVER_WORDS } from "./server-words.ts";
import { SHELL_WORDS } from "./shell-words.ts";
import { SETTINGS_PANES } from "../web/settings-registry.ts";
import { MANUAL_URL, MANUAL_URL_ZH, manualPage, PERSONAL_ONLY_PAGE, TWO_INSTALLATIONS_DOC } from "../web/manual-link.ts";

/** The web UI's words, kept as `[zh, en]` pairs so a translator reads both on one line (INV-1684). */
const UI_WORDS: Record<string, readonly [zh: string, en: string]> = {
  ...SERVER_ERRORS, // the web server's refusals, `err.<code>` (INV-1686)
  ...SERVER_WORDS, // its own pages and the usage forecast line (INV-1686)
  ...SHELL_WORDS, // the desktop shell's own notices (INV-1709)
  ...UI_PAGE,
  ...UI_APP,
  ...UI_TASK_FOCUS, ...UI_WORK_MANAGEMENT,
  ...UI_NEXT, ...UI_NEXT_LINE, ...UI_NEXT_PRESS, // the rebuilt page (INV-1825); a row's one line (INV-1926); what a press leads to
  ...UI_PERSONAL_COMPUTERS, ...UI_DIRECTORY, // the organisation's directory and activation (INV-2202)
  ...UI_ORG_SKILLS, // the organisation's skill library (INV-2222)
  ...UI_FIRST_SCREEN, // the first screen and Settings → Organisation (INV-2311)
  ...UI_SECTIONS,
  ...Object.fromEntries(SETTINGS_PANES.map(pane => [`ui.pane.${pane.key}`, [pane.titleZh, pane.title] as const])),
  ...Object.fromEntries(SETTINGS_PANES.map(pane => [`ui.pane.${pane.key}.about`, [pane.aboutZh, pane.about] as const])), // what each is for, on the rebuilt page (INV-1825)
  "ui.manualUrl": [MANUAL_URL_ZH, MANUAL_URL],
  "ui.manualUrl.personal-only": [manualPage(PERSONAL_ONLY_PAGE, "zh"), manualPage(PERSONAL_ONLY_PAGE, "en")], // INV-1689
  "ui.docUrl.two-installations": [TWO_INSTALLATIONS_DOC, TWO_INSTALLATIONS_DOC], // INV-1706
};

const uiIn = (index: 0 | 1) => Object.fromEntries(Object.entries(UI_WORDS).map(([key, pair]) => [key, pair[index]]));

const CHAT_AND_SETUP: Record<Locale, Record<string, string>> = {
  zh: {
    "team": "团队",
    "card.queued": "排队中",
    "card.queued.ahead": "排队中 — 前面还有{ahead}件",
    "card.working": "进行中",
    "card.review": "待你验收",
    "card.done": "已完成",
    "card.failed": "失败了",
    "card.open": "在工作台打开",
    "card.footnote": "来自{requester}",
    "ack.queued": "收到 — {who}前面还有{ahead}件事。做完会发在这里。",
    "ack.working": "{who}开工了。可能要一会儿,结果会发在这里。",
    "reply.empty": "做完了。(它没有留下说明。)",
    "files.noBox": "现在没有开着的沙盒,文件存不进去。",
    "files.saved": "收到:{names}。我先看一眼——你也可以直接说要做什么。",
    "files.more": "{first}等{count}个",
    "say.whatYouNeed": "说一句要做什么就开工;想指定谁来做,开头@它的名字。",
    "roster.empty": "这里还没有任何智能体。",
    "roster.default": "(不@人时由它接手)",
    "roster.footer": "@名字 指定谁来做;不指定就交给默认的那位。",
    "desktop.link": "{agent}的桌面(实时,可操作):\n{url}\n在飞书里点开就是网页版的那块屏幕。注意:拿到这个链接的人都能看,团队沙盒的提醒在页面顶上。",
    "desktop.notPublic": "还没配置从手机能访问的地址。在启动 web 的环境里设置 AGENTBOX_PUBLIC_URL (比如 Tailscale 的地址),桌面链接、任务卡片的「在工作台打开」按钮就都能点了。先用「屏幕」可以拿一张当前截图。",
    "agent.unknown": "没有叫\"{asked}\"的。这里能找到的是:{roster}。用 @名字 重新说一遍就行。",
    "agent.none": "(还没有智能体)",
    // Who a chat message reaches (INV-2221, docs/109 §4): src/host/chat-route.ts.
    "agent.preparing": "你自己的智能体还在准备中:你的沙盒正在排队或启动。好了之后直接在这里说话就行,不用 @。",
    "agent.noneHere": "这里还没有接手你私聊的智能体。打开页面给自己建一个,或者请管理员安排。",
    "agent.reachHint": "现在可以用 @名字 找:{roster}。",
    "agent.noneForRooms": "这个渠道还没有设默认智能体,群里不 @ 名字的消息没有人接手。开头用 @名字 指定一个,或者请管理员在渠道设置里选一个默认智能体。",
    "agent.ambiguous": "有{count}个叫\"{asked}\"的:\n{list}\n用 @ 加上面的编号,指定其中一个。",
    "agent.ambiguousLine": "· {name}(沙盒:{box})— @{id}",
    "consent.stakes": "在有人回复之前,这一步是停着的。拒绝可以随时反悔:它会跳过这一步,继续做别的。",
    "consent.title": "{agent}请你确认",
    "consent.once": "允许这一次",
    "consent.always": "一直允许",
    "consent.deny": "拒绝",
    "consent.fallback": "{agent}请你确认:\n{description}\n\n回复\"允许\"只批这一次,\"一直允许\"以后不再问,\"拒绝\"就不做。{stakes}",
    "consent.gone": "这条确认已经不在等了——可能已经在别处回复过,或者那件事已经走完了。",
    "question.title": "{agent}有个问题要先问你",
    "surface.title": "{agent}给你看一张卡片",
    "question.text": "{agent}有个问题要先问你:\n{question}{choices}\n\n直接在这里回复,它就接着干。",
    "question.terms.default": "\n\n(没回复的话就按这个走:{fallback})",
    "question.terms.byDefault": "\n\n({when}前没回复,就按这个走:{fallback})",
    "question.terms.byDecide": "\n\n({when}前没回复,它就自己定,并说明是怎么定的)",
    "run.stopping": "好,叫停了。当前这一步做完就停。",
    "run.nothing": "现在没有正在做的事。",
    "run.notYours": "{who}在你不在的那个沙盒里,所以这条没有生效。让管理员把你加进去,或者找那个沙盒里的人。",
    "run.it": "它",
    "run.steered": "带到了,{who}接着做。",
    "run.steeredAnon": "带到了,接着做。",
    "guests.closed": "这个渠道只对已经登记过的人开放,不收新的申请。要用的话,请让管理员先把你加进来。",
    "access.viewer": "你在这里是观察者:可以查看,但不能给智能体交代工作。需要的话,请管理员调整你的角色。",
    "access.asked": "你在这里还没有被激活。你的申请已经交给管理员了;激活之后,直接在这里说话就行。",
    "access.unlisted": "这个渠道只对本组织通讯录里的人开放,通讯录里没有你,所以没有记录申请。如果应该有你,请联系组织的管理员。",
    "access.activated": "管理员已经把你激活了。",
    "activation.ready": "你好，我是{agent}，你在 LumenBox 的助手，已经准备好了。在{url}用这个账号登录就能找到我；也可以直接在这里跟我说话。",
    "activation.ready-here": "你好，我是{agent}，你在 LumenBox 的助手，已经准备好了。直接在这里跟我说话就行。",
    "guests.over-cap": "今天在这个群里回答访客的次数已经用完了,明天再来问,或者请组织的成员帮你。",
    "guests.failed": "这次没能回答,请稍后再问,或者请组织的成员帮你。",
    "guests.held": "已收到，稍后回复。",
    "routine.idle-paused": "已暂停例行任务：{routines}。已经超过{days}天没有人给我发消息，所以它不再按时运行。有人再给我发消息时，它会自动恢复。",
    "guests.held-for-admin": "{agent}在群{chat}给访客的回答没有通过审查（{category}），还没发出。请在 设置 → 访客 里批准或丢弃。",
    "org-skills.offer-approved": "你提交的 skill「{name}」已被管理员批准，现在是组织 skill，每个沙盒都能用。",
    "org-skills.offer-declined": "你提交的 skill「{name}」没有被采纳为组织 skill：{reason}",
    "personal-box.asked": "管理员请求把你的沙盒「{box}」转交给{to}。转交后{to}能看到里面的一切，包括你留在里面的登录。在 设置 → 沙盒 里同意或拒绝；你答复之前什么都不会变。",
    "personal-box.declined": "{owner}没有同意把沙盒「{box}」转交出去，它仍归{owner}。",
    "personal-box.handed": "沙盒「{box}」已转交给你，原来归{from}。里面的浏览器和工具里可能还登录着{from}的账号：使用前请先退出这些登录。",
    "org.unverified-notice": "你负责的组织条目{id}（「{text}」）被{by}标为未核实：{reason}。智能体不再主动回忆它；请在 设置 → 记忆 里取代或撤回它。",
    "file.tooBig": "「{name}」太大,飞书不允许下载这么大的附件。压缩一下、拆小一点再发,或者换个格式。",
    "file.failed": "「{name}」我没拿下来(飞书下载接口报错{code})。再发一次试试,或换个发法。",
    "schedules.none": "现在没有自动运行的任务。要加一个,让智能体在 skill 的开头写上 schedule,比如每天早上 6:30 报一次。",
    "schedules.disarmed": "(定时器当前是关的,下面这些不会自动跑。)",
    "schedule.filesOnly": "只写文件",
    "schedule.here": "报到本群",
    "schedule.elsewhere": "报到别的群",
    "schedule.running": "正在跑",
    "schedule.lastRun": "上次{when}",
    "schedule.never": "还没跑过",
    "task.accepted": "好,{task}算完成了。",
    "refuse.scopeIsAdmin": "绑定 scope 会改变这个群里每件任务的权限,这要管理员来定。",
    "refuse.upgradeIsAdmin": "升级会重建这个沙盒,上面没存进卷里的东西都会没,这要管理员来定。",
    "upgrade.noneWaiting": "现在没有在等确认的升级。",
    "upgrade.approved": "好,记下了:{who}批准升级到{image}。\n这只是记录决定——沙盒会在下一次升级运行时重建,那次不会再问。现在什么都还没动。",
    "ui.attention.needsMe": "需要你",
    "ui.attention.outbox": "Outbox · 等你放行",
    "ui.attention.theirs": "你在等别人",
    "ui.attention.empty": "没有等你的事,你要的事也都没有卡住。",
    "ui.attention.keepOpen": "保持打开",
    "ui.attention.close": "关掉",
    "ui.manual": "手册",
    "ui.attention.notNow": "现在不看",
    "ui.attention.answer": "去回答",
    "ui.attention.open": "打开",
    "ui.setup.title": "开始使用",
    "ui.setup.close": "收起",
    "ui.setup.key": "配一个模型 key",
    "ui.setup.keyWhy": "没有它,智能体说不出第一个字。选一家供应商,粘贴密钥,保存并重启。",
    "ui.setup.keyAct": "去设置",
    "ui.setup.box": "给智能体一个沙盒",
    "ui.setup.boxWhy": "沙盒里有桌面、文件、命令行和引擎。可以新建 Docker 的,也可以接入一个现成的。",
    "ui.setup.boxAct": "设置一个沙盒",
    "ui.setup.boxOffline": "这台安装已使用过。目前沙盒离线，请到设置中检查连接。",
    "ui.setup.boxManage": "管理沙盒",
    "ui.setup.agent": "你的第一个智能体",
    "ui.setup.agentWhy": "智能体住在某一个沙盒里。从货架上盖一个——「设计」会帮你搭一整队。",
    "ui.setup.agentAct": "打开模板",
    "ui.setup.search": "联网搜索(可选)",
    "ui.setup.searchWhy": "不配搜索 key,智能体就没有 WebSearch 工具,查资料只能用沙盒里的浏览器凑合。Keenable、Brave 或 Tavily 任意一家的 key 都行,在设置 → Model 里粘贴。",
    "ui.setup.searchAct": "去设置",
    "ui.setup.skip": "跳过",
    "ui.setup.door": "一个渠道(可选)",
    "ui.setup.doorWhy": "飞书、钉钉或 Telegram 都能通到这个沙盒;这个网页本身也是一个渠道。",
    "ui.setup.doorAct": "连一个渠道",
    "ui.setup.work": "第一件活",
    "ui.setup.workWhy": "在聊天里说一句,或者加一张任务卡;进到待验收就算做完了。",
    "ui.setup.workAct": "打开任务板",
    "ui.boxes.none": "还没有沙盒。智能体在沙盒里干活——用上面的按钮建一个 Docker 的,或者在终端里跑 agentbox box up。",
    "ui.box.dockerMissing": "沙盒是本机 Docker 里运行的 Linux 环境。本机还没有 docker 命令——先安装并启动下面的其中一款,再回到这里按「启动沙盒」:",
    "ui.box.dockerStopped": "Docker 已安装,但引擎没有响应。启动 Docker Desktop(或 OrbStack),再按「启动沙盒」。",
    "ui.access.shared": "团队沙盒",
    "ui.access.sharedMembership": "团队沙盒：此安装允许登录的任何人，都可以通过连到这个沙盒的渠道或网页访问它。",
    "ui.access.private": "私有沙盒",
    "ui.access.privateUnenforced": "私有沙盒(未生效)",
    "ui.access.whoAll": "所有能打开它的人",
    "ui.access.whoGroup": "{group}里的人",
    "ui.access.sharedNotice": "这是一个团队沙盒。{who}都能看它的屏幕、读它的文件和命令历史,备份也会带走你在这里登录过的东西。在这里登录任何账号,等于替他们一起登录。",
    "ui.access.privateUnenforcedNotice": "这个沙盒被标成了私有,但**私有还没有生效**:能打开它的人都能看它的屏幕、读它的文件和命令历史,备份也会带走你在这里登录过的东西。在功能补齐之前,请当成团队沙盒用。",
    "ui.access.auditNotice": "这是一台公司运维用的跳板机。你在这里执行的命令与窗口活动会被记录、审计,并绑定到你的企业身份;请仅用于公司运维,不要用于个人或私人事务。",
  },
  en: {
    "team": "the team",
    "card.queued": "queued",
    "card.queued.ahead": "queued — {ahead} ahead of it",
    "card.working": "working",
    "card.review": "waiting on you",
    "card.done": "done",
    "card.failed": "failed",
    "card.open": "Open in the workshop",
    "card.footnote": "for {requester}",
    "ack.queued": "Got it — {who} has {ahead} thing(s) ahead of this. The result lands here.",
    "ack.working": "{who} is on it. It may take a while; the result lands here.",
    "reply.empty": "Done. (It left no note.)",
    "files.noBox": "No sandbox is running, so there is nowhere to put the files.",
    "files.saved": "Got {names}. I will take a look — or just say what you need done with them.",
    "files.more": "{first} and {count} others",
    "say.whatYouNeed": "Say what you need and it starts; to pick who does it, open with @their name.",
    "roster.empty": "No agent works here yet.",
    "roster.default": " (takes anything addressed to nobody)",
    "roster.footer": "@name picks who does it; without one it goes to the default.",
    "desktop.link": "{agent}'s desktop (live, and you can drive it):\n{url}\nOpening it in the chat shows the same screen the page does. Anyone with this link can watch; the shared-box notice is at the top of the page.",
    "desktop.notPublic": "No address a phone could reach is configured. Set AGENTBOX_PUBLIC_URL where the web server runs (a Tailscale address, say) and the desktop link and the card's \"Open in the workshop\" button both work. Meanwhile \"screen\" gets you a screenshot.",
    "agent.unknown": "There is nobody called \"{asked}\" here. You can reach: {roster}. Say it again with @their name.",
    "agent.none": "(no agent yet)",
    "agent.preparing": "Your own agent is still being prepared: your sandbox is queued or starting. Once it is up, just write here — no @ needed.",
    "agent.noneHere": "No agent answers your direct messages here yet. Open the page to make one of your own, or ask an Admin.",
    "agent.reachHint": " You can reach these with @name: {roster}.",
    "agent.noneForRooms": "This channel has no default agent, so nobody answers a group message that names no one. Open with @name to pick an agent, or ask an Admin to choose a default agent in the channel's settings.",
    "agent.ambiguous": "{count} agents are called \"{asked}\":\n{list}\nSay it again with @ and the id of the one you mean.",
    "agent.ambiguousLine": "· {name} (sandbox: {box}) — @{id}",
    "consent.stakes": "This step is stopped until somebody answers. Refusing is not final: it skips this step and carries on with the rest.",
    "consent.title": "{agent} needs your say-so",
    "consent.once": "Allow once",
    "consent.always": "Always allow",
    "consent.deny": "Refuse",
    "consent.fallback": "{agent} needs your say-so:\n{description}\n\nReply \"allow\" for this once, \"always allow\" to stop being asked, \"refuse\" to skip it. {stakes}",
    "consent.gone": "That request is no longer waiting — it was answered somewhere else, or the work it belonged to has moved on.",
    "question.title": "{agent} has a question first",
    "surface.title": "{agent} shows you a card",
    "question.text": "{agent} has a question first:\n{question}{choices}\n\nAnswer here and it carries on.",
    "question.terms.default": "\n\n(With no answer it goes with: {fallback})",
    "question.terms.byDefault": "\n\n(No answer by {when} and it goes with: {fallback})",
    "question.terms.byDecide": "\n\n(No answer by {when} and it decides itself, saying which way it went)",
    "run.stopping": "Stopping. It finishes the step it is on and stops there.",
    "run.nothing": "Nothing is running.",
    "run.notYours": "{who} is in a sandbox you are not in, so that did not take effect. Ask an admin to add you, or ask somebody who is in it.",
    "run.it": "it",
    "run.steered": "Passed on — {who} carries on with it.",
    "run.steeredAnon": "Passed on; carrying on.",
    "guests.closed": "This channel is open only to people who are already registered, and takes no new requests. Ask an admin to add you first.",
    "access.viewer": "You're a viewer here: you can watch, but not give the agents work. An admin can change your role if you need to.",
    "access.asked": "You have not been activated here yet. Your request is with the Admins; once they activate you, just write here.",
    "access.unlisted": "This channel is for people in the organisation's directory, and it does not list you, so no request was made. If it should, ask one of the organisation's Admins.",
    "access.activated": "An Admin has activated you here.",
    "guests.over-cap": "Today's answers for guests in this group chat are used up. Ask again tomorrow, or ask a member of the organisation.",
    "guests.failed": "This question could not be answered just now. Ask again later, or ask a member of the organisation.",
    "guests.held": "Received — we will reply shortly.",
    "activation.ready": "Hello, I'm {agent}, your LumenBox assistant, and I'm ready. Sign in at {url} with this account to find me, or just talk to me here.",
    "activation.ready-here": "Hello, I'm {agent}, your LumenBox assistant, and I'm ready. Just talk to me here.",
    "routine.idle-paused": "Scheduled work paused: {routines}. Nobody has sent me a message for over {days} days, so it no longer runs on its schedule. It starts again by itself when someone writes to me.",
    "guests.held-for-admin": "{agent}'s answer to a guest in {chat} did not pass the review ({category}) and has not been sent. Approve or discard it in Settings → Guests.",
    "org-skills.offer-approved": "\"{name}\", the skill you offered, was approved by an Admin and is now an organisation skill, in every sandbox.",
    "org-skills.offer-declined": "\"{name}\", the skill you offered, was not taken as an organisation skill: {reason}",
    "personal-box.asked": "An Admin asked to hand your sandbox \"{box}\" to {to}. {to} would then see everything in it, including the sign-ins you left there. Agree or decline in Settings → Sandboxes; nothing changes until you answer.",
    "personal-box.declined": "{owner} did not agree to hand over the sandbox \"{box}\"; it stays {owner}'s.",
    "personal-box.handed": "The sandbox \"{box}\" is now yours; it was {from}'s. Its browser and tools may still be signed in as {from}: sign out of those before you use it.",
    "org.unverified-notice": "Your organisation item {id} (\"{text}\") was marked unverified by {by}: {reason}. Agents no longer recall it on their own; supersede or retract it in Settings → Memory.",
    "file.tooBig": "\"{name}\" is too large — Feishu will not let an app download an attachment that size. Compress it, split it, or send another format.",
    "file.failed": "I could not fetch \"{name}\" (the download API returned{code}). Send it again, or another way.",
    "schedules.none": "Nothing runs on its own here. To add one, have an agent write a schedule at the top of a skill — a 06:30 brief, say.",
    "schedules.disarmed": "(The timer is off, so none of these will fire.)",
    "schedule.filesOnly": "writes files only",
    "schedule.here": "reports here",
    "schedule.elsewhere": "reports to another group chat",
    "schedule.running": "running now",
    "schedule.lastRun": "last {when}",
    "schedule.never": "never run",
    "task.accepted": "Right, {task} counts as done.",
    "refuse.scopeIsAdmin": "Binding a scope changes what every task in this group chat may do; that is an admin's call.",
    "refuse.upgradeIsAdmin": "An upgrade rebuilds this sandbox, and anything not in a volume is lost; that is an admin's call.",
    "upgrade.noneWaiting": "No upgrade is waiting for an answer.",
    "upgrade.approved": "Recorded: {who} approved the upgrade to {image}.\nThat records the decision — the sandbox is rebuilt at the next upgrade run, which will not ask again. Nothing has changed yet.",
    "ui.attention.needsMe": "Needs you",
    "ui.attention.outbox": "Outbox · waiting on you",
    "ui.attention.theirs": "You are waiting on",
    "ui.attention.empty": "Nothing is waiting on you, and nothing you asked for is outstanding.",
    "ui.attention.keepOpen": "Keep open",
    "ui.attention.close": "Close",
    "ui.manual": "Manual",
    "ui.attention.notNow": "Not now",
    "ui.attention.answer": "Answer",
    "ui.attention.open": "Open",
    "ui.setup.title": "Set up",
    "ui.setup.close": "close",
    "ui.setup.key": "A model key",
    "ui.setup.keyWhy": "Without it, an agent cannot say its first word. Pick a provider, paste the key, save and restart.",
    "ui.setup.keyAct": "Open settings",
    "ui.setup.box": "A sandbox for the agents",
    "ui.setup.boxWhy": "A sandbox holds a desktop, files, a shell and engines. Create the Docker sandbox, or attach one.",
    "ui.setup.boxAct": "Set up a sandbox",
    "ui.setup.boxOffline": "This installation has already been used. The sandbox is currently offline; check its connection in Settings.",
    "ui.setup.boxManage": "Manage sandboxes",
    "ui.setup.agent": "Your first agent",
    "ui.setup.agentWhy": "An agent lives in one sandbox. Stamp one from the shelf — 设计 (Team designer) builds a team for you.",
    "ui.setup.agentAct": "Open templates",
    "ui.setup.search": "Web search (optional)",
    "ui.setup.searchWhy": "Without a search key agents have no WebSearch tool and fall back to the sandbox's browser. Any one of Keenable, Brave or Tavily works — paste it in Settings → Model.",
    "ui.setup.searchAct": "Open settings",
    "ui.setup.skip": "skip",
    "ui.setup.door": "A channel (optional)",
    "ui.setup.doorWhy": "Feishu, DingTalk or Telegram reach this sandbox; this page is a channel too.",
    "ui.setup.doorAct": "Connect a channel",
    "ui.setup.work": "First work",
    "ui.setup.workWhy": "Say it in chat or add a task; it is done when it reaches review.",
    "ui.setup.workAct": "Open tasks",
    "ui.boxes.none": "No sandboxes yet. Your agents work in a sandbox — create the Docker sandbox with the button above, or run agentbox box up in a terminal.",
    "ui.box.dockerMissing": "The sandbox is a Linux environment running in Docker on this computer, and this computer has no docker command yet. Install and start one of the following, then come back and press Start the sandbox:",
    "ui.box.dockerStopped": "Docker is installed, but its engine did not answer. Start Docker Desktop (or OrbStack), then press Start the sandbox.",
    "ui.access.shared": "Team sandbox",
    "ui.access.sharedMembership": "Team sandbox: anyone admitted to this installation can reach it from its connected channels or the web page.",
    "ui.access.private": "Private sandbox",
    "ui.access.privateUnenforced": "Private sandbox (not in effect)",
    "ui.access.whoAll": "Everyone who can open it",
    "ui.access.whoGroup": "The people in {group}",
    "ui.access.sharedNotice": "This is a team sandbox. {who} can see its screen and read its files and command history, and a backup takes whatever you logged in to here. Logging in to any account here logs them in too.",
    "ui.access.privateUnenforcedNotice": "This sandbox is marked private, but **private is not in effect yet**: anyone who can open it can see its screen and read its files and command history, and a backup takes whatever you logged in to here. Treat it as a team sandbox until the feature is complete.",
    "ui.access.auditNotice": "This is a company operations jump host. The commands you run and the windows you use here are recorded, audited and tied to your company identity; use it for company operations only, not for personal matters.",
  },
};

export const MESSAGES: Record<Locale, Record<string, string>> = {
  zh: { ...CHAT_AND_SETUP.zh, ...uiIn(0) },
  en: { ...CHAT_AND_SETUP.en, ...uiIn(1) },
};

/**
 * One message, in one language, with `{name}` filled.
 *
 * A key with no message falls back to the default locale and then to the key itself: a
 * screen with a raw key on it is bad, and a screen with nothing on it is worse. The parity
 * test is what keeps that path from being reached.
 */
export function tr(key: string, locale: Locale = DEFAULT_LOCALE, vars: Record<string, string | number> = {}): string {
  const text = MESSAGES[locale]?.[key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
  return fillWords(text, vars);
}
