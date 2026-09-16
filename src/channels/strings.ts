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
 * whole user-facing vocabulary is on one page and a locale switch has exactly one seam.
 *
 * **That switch is now taken (INV-544).** The words live in `src/i18n/messages.ts`, in both
 * languages, and every function here takes an optional locale — absent means the
 * installation's default, which is what every call site meant before this existed, so
 * nothing had to change at once. The page reads the same bundle, which is the point: the
 * same person was reading Chinese cards in Feishu and English buttons on the web.
 *
 * Two kinds of text stay out of scope here: what the model says (it answers in the
 * person's language already), and technical action descriptions inside consent requests
 * (they name commands and paths, and translating those would blur what is being approved).
 */

import { DEFAULT_LOCALE, type Locale } from "../i18n/locale.ts";
import { tr } from "../i18n/messages.ts";

/** The people-words for an unnamed agent or the whole team. */
export const TEAM = tr("team", DEFAULT_LOCALE);

export const teamWord = (locale: Locale = DEFAULT_LOCALE): string => tr("team", locale);

// ── task card ──────────────────────────────────────────────────────────────────

export const CARD_STATUS = {
  queued: (ahead?: number, locale: Locale = DEFAULT_LOCALE) =>
    ahead !== undefined ? tr("card.queued.ahead", locale, { ahead }) : tr("card.queued", locale),
  working: tr("card.working", DEFAULT_LOCALE),
  review: tr("card.review", DEFAULT_LOCALE),
  done: tr("card.done", DEFAULT_LOCALE),
  failed: tr("card.failed", DEFAULT_LOCALE),
} as const;

/** The same statuses in a chosen language, for a card rendered for one person. */
export const cardStatus = (status: "working" | "review" | "done" | "failed", locale: Locale = DEFAULT_LOCALE): string =>
  tr(`card.${status}`, locale);

export const OPEN_WORKSHOP = tr("card.open", DEFAULT_LOCALE);
export const openWorkshop = (locale: Locale = DEFAULT_LOCALE): string => tr("card.open", locale);

/** The card footnote: which task, for whom. */
export function cardFootnote(taskId: string | undefined, requesterLabel: string, locale: Locale = DEFAULT_LOCALE): string {
  return `${taskId !== undefined ? `${taskId} · ` : ""}${tr("card.footnote", locale, { requester: requesterLabel })}`;
}

// ── acknowledgements ───────────────────────────────────────────────────────────

export function ackQueued(who: string, ahead: number, locale: Locale = DEFAULT_LOCALE): string {
  return tr("ack.queued", locale, { who, ahead });
}

export function ackWorking(who: string, locale: Locale = DEFAULT_LOCALE): string {
  return tr("ack.working", locale, { who });
}

export const EMPTY_REPLY_NOTE = tr("reply.empty", DEFAULT_LOCALE);

// ── files ──────────────────────────────────────────────────────────────────────

export const NO_BOX_FOR_FILES = tr("files.noBox", DEFAULT_LOCALE);

/** The receipt for a wordless drop. Basenames, not box paths — the person sent names. */
export function filesSaved(saved: readonly string[], locale: Locale = DEFAULT_LOCALE): string {
  const names = saved.map(path => path.split("/").pop() ?? path);
  const shown =
    names.length > 3
      ? tr("files.more", locale, { first: names.slice(0, 3).join("、"), count: names.length })
      : names.join("、");
  return tr("files.saved", locale, { names: shown });
}

export const SAY_WHAT_YOU_NEED = tr("say.whatYouNeed", DEFAULT_LOCALE);

/** The roster, for the chat that asked 「团队」. One line per worker, the door's default marked. */
export function rosterText(
  agents: readonly { name: string; title?: string; isDefault: boolean }[],
  locale: Locale = DEFAULT_LOCALE
): string {
  if (agents.length === 0) return tr("roster.empty", locale);
  const lines = agents.map(agent => {
    const role = agent.title ? ` — ${agent.title}` : "";
    return `${agent.name}${role}${agent.isDefault ? tr("roster.default", locale) : ""}`;
  });
  return `${lines.join("\n")}\n${tr("roster.footer", locale)}`;
}

/** The desktop, opened from a phone: the link, plus what opening it means. */
export function desktopLink(agentName: string, url: string, locale: Locale = DEFAULT_LOCALE): string {
  return tr("desktop.link", locale, { agent: agentName, url });
}

export const DESKTOP_NOT_PUBLIC = tr("desktop.notPublic", DEFAULT_LOCALE);

/** A wrong @ answered with the way in, not just the way it failed. */
export function unknownAgent(asked: string, names: readonly string[], locale: Locale = DEFAULT_LOCALE): string {
  const roster = names.length > 0 ? names.join("、") : tr("agent.none", locale);
  return tr("agent.unknown", locale, { asked, roster });
}

// ── consent(安全确认)────────────────────────────────────────────────────────

export const APPROVAL_STAKES = tr("consent.stakes", DEFAULT_LOCALE);

export function consentTitle(agentName: string, locale: Locale = DEFAULT_LOCALE): string {
  return tr("consent.title", locale, { agent: agentName || tr("team", locale) });
}

export const CONSENT_BUTTONS = {
  once: tr("consent.once", DEFAULT_LOCALE),
  always: tr("consent.always", DEFAULT_LOCALE),
  deny: tr("consent.deny", DEFAULT_LOCALE),
} as const;

export function consentFallbackText(agentName: string, description: string, locale: Locale = DEFAULT_LOCALE): string {
  return tr("consent.fallback", locale, {
    agent: agentName || tr("team", locale),
    description,
    stakes: tr("consent.stakes", locale),
  });
}

export const CONSENT_GONE = tr("consent.gone", DEFAULT_LOCALE);

// ── questions from the agent ───────────────────────────────────────────────────

export function questionTitle(agentName: string, locale: Locale = DEFAULT_LOCALE): string {
  return tr("question.title", locale, { agent: agentName || tr("team", locale) });
}

export function questionText(agentName: string, question: string, choices: string, locale: Locale = DEFAULT_LOCALE): string {
  return tr("question.text", locale, { agent: agentName || tr("team", locale), question, choices });
}

/**
 * 到期会发生什么,写在问题下面 (INV-533)。
 *
 * 默认值和截止时间以前只存在宿主内存里:到点之后 bot 说"按默认走了",而被问的人从未
 * 被告知有这么一个默认、也不知道有个钟在走。事先说好,才谈得上"沉默=按默认"。
 */
export function questionTerms(fallback: string | undefined, expiresAt: number | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (expiresAt === undefined) return fallback === undefined ? "" : tr("question.terms.default", locale, { fallback });
  const when = new Date(expiresAt).toLocaleString(locale === "en" ? "en-GB" : "zh-CN", {
    hour12: false,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return fallback === undefined
    ? tr("question.terms.byDecide", locale, { when })
    : tr("question.terms.byDefault", locale, { when, fallback });
}

// ── the running task:停 与改 ──────────────────────────────────────────────────

export const STOPPING = tr("run.stopping", DEFAULT_LOCALE);
export const NOTHING_RUNNING = tr("run.nothing", DEFAULT_LOCALE);

/** 这道门不收访客 (INV-429)：说清楚是规则，不是故障,也不是在排队等人批。 */
export function guestsClosed(locale: Locale = DEFAULT_LOCALE): string {
  return tr("guests.closed", locale);
}

/** 不是"没在跑",是"这个不归你管" (INV-538)。含糊其辞会让人以为自己按错了。 */
export function notYours(who: string | undefined, locale: Locale = DEFAULT_LOCALE): string {
  return tr("run.notYours", locale, { who: who ?? tr("run.it", locale) });
}

export function steered(who: string | undefined, locale: Locale = DEFAULT_LOCALE): string {
  // No name is better than a wrong one: without an @-address the manager does not know
  // which agent is on it, and "团队接着做" read as if a committee had the file.
  return who !== undefined ? tr("run.steered", locale, { who }) : tr("run.steeredAnon", locale);
}

// ── file fetch failures ────────────────────────────────────────────────────────

/**
 * A file the bot could not pull down, said to the person who sent it.
 *
 * Observed live: a 400 with Feishu code 234037 (size limit) was logged host-side and the
 * chat heard nothing — the agent then looked at an empty inbox and guessed out loud. The
 * failure of a delivery must land where the delivery was attempted.
 */
export function fileFetchFailed(name: string, code: number | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (code === 234037) return tr("file.tooBig", locale, { name });
  return tr("file.failed", locale, { name, code: code !== undefined ? ` ${code}` : "" });
}

// ── 定时(automations)─────────────────────────────────────────────────────────

export const NO_SCHEDULES = tr("schedules.none", DEFAULT_LOCALE);
export const SCHEDULES_DISARMED = tr("schedules.disarmed", DEFAULT_LOCALE);

/**
 * One automation, as the chat shows it.
 *
 * Says where it reports, because the difference between "runs and tells this room" and
 * "runs quietly" is the one thing a person cannot guess and the one that made scheduled
 * skills look broken — they ran for weeks into a conversation no chat reads.
 */
export function scheduleLine(
  entry: {
    name: string;
    described: string;
    agent?: string;
    timezone?: string;
    deliver?: string;
    lastRun?: string;
    running: boolean;
    here: boolean;
  },
  locale: Locale = DEFAULT_LOCALE
): string {
  const when = entry.timezone !== undefined ? `${entry.described}(${entry.timezone})` : entry.described;
  const who = entry.agent !== undefined ? ` · ${entry.agent}` : "";
  const where = ` · ${entry.deliver === undefined ? tr("schedule.filesOnly", locale) : entry.here ? tr("schedule.here", locale) : tr("schedule.elsewhere", locale)}`;
  const last = ` · ${
    entry.running
      ? tr("schedule.running", locale)
      : entry.lastRun !== undefined
        ? tr("schedule.lastRun", locale, { when: entry.lastRun.slice(5, 16).replace("T", " ") })
        : tr("schedule.never", locale)
  }`;
  return `· ${entry.name} — ${when}${who}${where}${last}`;
}

// ── acceptance(验收)─────────────────────────────────────────────────────────

export function accepted(taskId: string, locale: Locale = DEFAULT_LOCALE): string {
  return tr("task.accepted", locale, { task: taskId });
}

// ── refusals ───────────────────────────────────────────────────────────────────

export const SCOPE_IS_ADMIN_CALL = tr("refuse.scopeIsAdmin", DEFAULT_LOCALE);
export const UPGRADE_IS_ADMIN_CALL = tr("refuse.upgradeIsAdmin", DEFAULT_LOCALE);

/**
 * Said when the word arrives with no question behind it.
 *
 * Not silence and not a refusal: with nothing pending, "升级" is almost always somebody
 * talking about upgrading something else, and answering as though they had tried to
 * destroy a box would be both wrong and alarming.
 */
export const NO_UPGRADE_WAITING = tr("upgrade.noneWaiting", DEFAULT_LOCALE);

/** Said when a decision has just been recorded — exactly what it did and did not do. */
export function upgradeApproved(image: string, who: string, locale: Locale = DEFAULT_LOCALE): string {
  return tr("upgrade.approved", locale, { image, who });
}
