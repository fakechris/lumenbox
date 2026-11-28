/**
 * What a press leads to, on the rebuilt page: the line under a card's buttons that says what each one does, and the
 * button on an inbox row that goes where the row is dealt with. Said on the page, not in a tooltip: a person facing three
 * or four buttons was left to guess why they would pick one and what would follow.
 */
export const UI_NEXT_PRESS: Record<string, readonly [string, string]> = {
  "ui.next.inbox.go": ["去{place}处理", "Go to {place}"],
  // Which agent answers a person's direct messages in a chat channel, and the press that makes it this one (INV-2221).
  "ui.next.member.makeHome": ["让它接手我的私聊", "Have it answer my direct messages"],
  "ui.next.member.isHome": ["你在聊天渠道里的私聊，不 @ 名字时由它接手。", "It answers your direct messages in a chat channel, when you name nobody."],
  "ui.next.member.homeSet": ["以后你的私聊由它接手。", "It answers your direct messages from now on."],
  "ui.next.agent.home": ["回答你的私聊", "Answers your DMs"],
  "ui.next.need.hint.act": ["做完后点“我做完了”，{name}会接着做；“先不管”会让它先做不需要这一步的部分。", "Press “I've done it” when it is done and {name} carries on; “Skip for now” tells it to go on with what does not need this."],
  "ui.next.need.hint.release": ["同意，{name}就照做；不同意，它就不做，可以顺便说一句理由。都只是这一次的答复，不改变任何权限设置。", "Say yes and {name} goes ahead; say no and it does not, with a reason if you like. Either is an answer for this once and changes no permission setting."],
  "ui.next.need.hint.later": ["“延后”：选一个时间，在那之前不再问你这件事。", "“Put off”: pick a time, and you are not asked about this again until then."],
  "ui.next.need.hint.answer": ["选一个，或直接在下面回复{name}。", "Pick one, or just reply to {name} below."],
  "ui.next.adjust.title": ["放手程度和要等的工作", "How far it goes alone, and what it waits on"],
  "ui.next.act.markDone": ["算它完成了", "Count it as done"],
  "ui.next.done.markedDone": ["已算作完成", "Counted as done"],
  "ui.next.panel.footHint": ["“算它完成了”：这件事到此结束，{name}不再做它，也不再等你。“停止这件工作”：中断它正在做的，已经在外面发生的变化要你核对。", "“Count it as done” closes it: {name} stops working on it and nothing waits on you. “Stop this work” interrupts what it is doing; check what already happened outside."],
  "ui.next.need.next": ["下一件（{n}/{m}）", "Next ({n}/{m})"],
};
