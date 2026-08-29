/**
 * Every sentence a chat user reads, in the language they work in.
 *
 * The product's market is Feishu and DingTalk — a Chinese workplace — and until this file
 * existed the cards said "Ada needs your consent", "Allow once", "In review — your turn".
 * The third product review put it plainly: for the core user, an English card means "this
 * is not for me", and the loss happens in the first second. The strings were also pinned
 * by tests, which is how they survived every UI pass: the tests asserted the words instead
 * of the meaning.
 *
 * One module rather than strings scattered through two adapters and a manager, so the
 * whole user-facing vocabulary is on one page and a future locale switch has exactly one
 * seam. Deliberately not an i18n framework: that is a cost the product has not earned yet.
 *
 * Two kinds of text stay out of scope here: what the model says (it answers in the
 * person's language already), and technical action descriptions inside consent requests
 * (they name commands and paths, and translating those would blur what is being approved).
 */

/** The people-words for an unnamed agent or the whole team. */
export const TEAM = "团队";

// ── task card ──────────────────────────────────────────────────────────────────

export const CARD_STATUS = {
  queued: (ahead?: number) => (ahead !== undefined ? `排队中 — 前面还有 ${ahead} 件` : "排队中"),
  working: "进行中",
  review: "待你验收",
  done: "已完成",
  failed: "失败了",
} as const;

export const OPEN_WORKSHOP = "在工作台打开";

/** The card footnote: which task, for whom. */
export function cardFootnote(taskId: string | undefined, requesterLabel: string): string {
  return `${taskId !== undefined ? `${taskId} · ` : ""}来自 ${requesterLabel}`;
}

// ── acknowledgements ───────────────────────────────────────────────────────────

export function ackQueued(who: string, ahead: number): string {
  return `收到 — ${who}前面还有 ${ahead} 件事。做完会发在这里。`;
}

export function ackWorking(who: string): string {
  return `${who}开工了。可能要一会儿,结果会发在这里。`;
}

export const EMPTY_REPLY_NOTE = "做完了。(它没有留下说明。)";

// ── files ──────────────────────────────────────────────────────────────────────

export const NO_BOX_FOR_FILES = "现在没有开着的工作机,文件存不进去。";

/** The receipt for a wordless drop. Basenames, not box paths — the person sent names. */
export function filesSaved(saved: readonly string[]): string {
  const names = saved.map(path => path.split("/").pop() ?? path);
  const shown = names.length > 3 ? `${names.slice(0, 3).join("、")} 等 ${names.length} 个` : names.join("、");
  return `收到:${shown}。我先看一眼——你也可以直接说要做什么。`;
}

export const SAY_WHAT_YOU_NEED = "说一句要做什么就开工;想指定谁来做,开头@它的名字。";

/** The roster, for the chat that asked 「团队」. One line per worker, the door's default marked. */
export function rosterText(
  agents: readonly { name: string; title?: string; isDefault: boolean }[]
): string {
  if (agents.length === 0) return "这里还没有任何成员。";
  const lines = agents.map(agent => {
    const role = agent.title ? ` — ${agent.title}` : "";
    return `${agent.name}${role}${agent.isDefault ? "(不@人时由它接手)" : ""}`;
  });
  return `${lines.join("\n")}\n@名字 指定谁来做;不指定就交给默认的那位。`;
}

/** A wrong @ answered with the way in, not just the way it failed. */
export function unknownAgent(asked: string, names: readonly string[]): string {
  const roster = names.length > 0 ? names.join("、") : "(还没有成员)";
  return `没有叫"${asked}"的。这里能找到的是:${roster}。用 @名字 重新说一遍就行。`;
}

// ── consent(安全确认)────────────────────────────────────────────────────────

export const APPROVAL_STAKES =
  "在有人回复之前,这一步是停着的。拒绝可以随时反悔:它会跳过这一步,继续做别的。";

export function consentTitle(agentName: string): string {
  return `${agentName || TEAM} 请你确认`;
}

export const CONSENT_BUTTONS = { once: "允许这一次", always: "一直允许", deny: "拒绝" } as const;

export function consentFallbackText(agentName: string, description: string): string {
  return (
    `${agentName || TEAM} 请你确认:\n${description}\n\n` +
    `回复"允许"只批这一次,"一直允许"以后不再问,"拒绝"就不做。${APPROVAL_STAKES}`
  );
}

export const CONSENT_GONE = "这条确认已经不在等了——可能已经在别处回复过,或者那件事已经走完了。";

// ── questions from the agent ───────────────────────────────────────────────────

export function questionTitle(agentName: string): string {
  return `${agentName || TEAM} 有个问题要先问你`;
}

export function questionText(agentName: string, question: string, choices: string): string {
  return `${agentName || TEAM} 有个问题要先问你:\n${question}${choices}\n\n直接在这里回复,它就接着干。`;
}

// ── the running task:停 与改 ──────────────────────────────────────────────────

export const STOPPING = "好,叫停了。当前这一步做完就停。";

export const NOTHING_RUNNING = "现在没有正在做的事。";

export function steered(who: string | undefined): string {
  // No name is better than a wrong one: without an @-address the manager does not know
  // which agent is on it, and "团队接着做" read as if a committee had the file.
  return who !== undefined ? `带到了,${who}接着做。` : "带到了,接着做。";
}

// ── file fetch failures ────────────────────────────────────────────────────────

/**
 * A file the bot could not pull down, said to the person who sent it.
 *
 * Observed live: a 400 with Feishu code 234037 (size limit) was logged host-side and the
 * chat heard nothing — the agent then looked at an empty inbox and guessed out loud. The
 * failure of a delivery must land where the delivery was attempted.
 */
export function fileFetchFailed(name: string, code: number | undefined): string {
  if (code === 234037) {
    return `「${name}」太大,飞书不让机器人下载这个尺寸的附件。压缩一下、拆小一点再发,或者换个格式。`;
  }
  return `「${name}」我没拿下来(飞书下载接口报错${code !== undefined ? ` ${code}` : ""})。再发一次试试,或换个发法。`;
}

// ── 定时(automations)─────────────────────────────────────────────────────────

export const NO_SCHEDULES =
  "现在没有自动运行的任务。要加一个,让 agent 在 skill 的开头写上 schedule,比如每天早上 6:30 报一次。";

export const SCHEDULES_DISARMED = "(定时器当前是关的,下面这些不会自动跑。)";

/**
 * One automation, as the chat shows it.
 *
 * Says where it reports, because the difference between "runs and tells this room" and
 * "runs quietly" is the one thing a person cannot guess and the one that made scheduled
 * skills look broken — they ran for weeks into a conversation no chat reads.
 */
export function scheduleLine(entry: {
  name: string;
  described: string;
  agent?: string;
  timezone?: string;
  deliver?: string;
  lastRun?: string;
  running: boolean;
  here: boolean;
}): string {
  const when = entry.timezone !== undefined ? `${entry.described}(${entry.timezone})` : entry.described;
  const who = entry.agent !== undefined ? ` · ${entry.agent}` : "";
  const where = entry.deliver === undefined ? " · 只写文件" : entry.here ? " · 报到本群" : " · 报到别的群";
  const last =
    entry.running
      ? " · 正在跑"
      : entry.lastRun !== undefined
        ? ` · 上次 ${entry.lastRun.slice(5, 16).replace("T", " ")}`
        : " · 还没跑过";
  return `· ${entry.name} — ${when}${who}${where}${last}`;
}

// ── acceptance(验收)─────────────────────────────────────────────────────────

export function accepted(taskId: string): string {
  return `好,${taskId} 算完成了。`;
}

// ── refusals ───────────────────────────────────────────────────────────────────

export const SCOPE_IS_ADMIN_CALL = "绑定 scope 会改变这个群里每件任务的权限,这要管理员来定。";
