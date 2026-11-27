/**
 * What a DingTalk robot message says about where it was said (INV-2225).
 *
 * The three facts `ChannelManager.handle` decides on — a direct message, a message for the
 * bot, the room's name — read off the fields DingTalk's robot callback carries
 * (open.dingtalk.com/document/development/robot-message-type, "机器人接收消息 > 消息体"):
 *
 * - `conversationType`: `"1"` a one-to-one session (单聊), `"2"` a group (群聊).
 * - `isInAtList`: whether the robot is in the message's @ list.
 * - `conversationTitle`: the group's title, present only in a group (群聊时才有的会话标题).
 *
 * On `addressed`: the stream topic this adapter subscribes to delivers, in a group, only the
 * messages that @ the robot (see `TOPIC` in dingtalk.ts), so a group frame is addressed unless
 * the wire says plainly that it is not (`isInAtList: false`). That keeps the answer true if a
 * robot is ever granted every group message, and fails open — the manager's reading of absent —
 * when the flag is missing.
 */

import type { InboundMessage } from "./manager.ts";

export type RoomFacts = Pick<InboundMessage, "privateChat" | "addressed" | "chatName">;

export function roomFactsOf(message: {
  conversationType?: string;
  isInAtList?: boolean;
  conversationTitle?: string;
}): RoomFacts {
  if (message.conversationType === "1") return { privateChat: true, addressed: true };
  const title = typeof message.conversationTitle === "string" ? message.conversationTitle.trim() : "";
  return {
    ...(message.conversationType === "2" ? { privateChat: false } : {}),
    addressed: message.isInAtList !== false,
    ...(title !== "" ? { chatName: title } : {}),
  };
}
