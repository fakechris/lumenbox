/**
 * A channel's status, said in its reader's language (INV-1702).
 *
 * The status line was fixed in English when the door registered ("set FEISHU_APP_ID and
 * FEISHU_APP_SECRET"), so Settings → Channels read English to a Chinese reader. A line is now a
 * key and its blanks, worded when the list is read; an environment variable's name is a blank and
 * stays as typed. An adapter's own error text has no key and is shown as it came.
 */

import { tr } from "../i18n/messages.ts";
import type { Locale } from "../i18n/locale.ts";

export type StatusLine = { key: string; vars?: Record<string, string | number> } | { text: string };

export interface ChannelStatus {
  name: string;
  configured: boolean;
  running: boolean;
  detail: string;
}

export const STARTING: StatusLine = { key: "channel.status.starting" };
export const CONNECTED: StatusLine = { key: "channel.status.connected" };

/** What a person must set before the channel can start: one variable or a pair. */
export function needsEnv(first: string, second?: string): StatusLine {
  return second === undefined ? { key: "channel.status.set-one", vars: { name: first } } : { key: "channel.status.set-two", vars: { first, second } };
}

/** A plain string is text as written, which is how a test and an adapter's error say it. */
export function statusText(line: StatusLine | string, locale: Locale): string {
  if (typeof line === "string") return line;
  return "text" in line ? line.text : tr(line.key, locale, line.vars ?? {});
}
