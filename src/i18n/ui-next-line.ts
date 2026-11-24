/**
 * The fixed words of a row's one line, where the member wrote nothing (INV-1926): where the work
 * stands, said the way a person says it, and where it is stuck. The work panel keeps its fuller
 * account in `ui.wr.*`.
 */
export const UI_NEXT_LINE: Record<string, readonly [string, string]> = {
  "ui.next.line.answer": ["等你回答", "Waiting for your answer"],
  "ui.next.line.await.approval": ["等你允许它做一步操作", "Waiting for you to allow a step"],
  "ui.next.line.await.handoff": ["等你把桌面交还给它", "Waiting for you to hand the desktop back"],
  "ui.next.line.await.spend-limit": ["到了花费上限，等你决定", "At its spending limit; waiting for you"],
  "ui.next.line.await.provider-resting": ["模型服务暂时不可用，稍后会接着做", "The model service is resting; it carries on later"],
  "ui.next.line.await.other": ["等你", "Waiting for you"],
  "ui.next.line.reason.proposal": ["等你同意后才开始", "Starts once you agree to it"],
  "ui.next.line.reason.queued": ["排着队，还没开始", "Queued, not started yet"],
  "ui.next.line.reason.working": ["正在做", "Working on it"],
  "ui.next.line.reason.checking": ["已交付，等检查", "Delivered, waiting for a check"],
  "ui.next.line.reason.review": ["已交付，等你确认", "Delivered, waiting for you to confirm"],
  "ui.next.line.reason.needs": ["等你回答或确认", "Waiting for you to answer or confirm"],
  "ui.next.line.reason.waiting": ["停着，等它要的东西到了再做", "Paused until what it waits for arrives"],
  "ui.next.line.reason.historicalWaiting": ["很久没有动静，可能已经不在做了", "Nothing has moved for a long time; it may have stopped"],
  "ui.next.line.blocker.queue": ["排着队，还没开始", "Queued, not started yet"],
  "ui.next.line.blocker.interrupted": ["做到一半断了，要接着做", "Cut off halfway; it needs picking up again"],
  "ui.next.line.blocker.focus": ["先放着，它在忙另一件事", "Set aside while it does something else"],
  "ui.next.line.blocker.capability": ["卡住了：缺少要用的工具或环境", "Stuck: a tool or setup it needs is missing"],
  "ui.next.line.blocker.confirmation": ["等你确认", "Waiting for you to confirm"],
  "ui.next.line.blocker.dependency": ["等另一件工作的结果", "Waiting on another piece of work"],
  "ui.next.line.blocker.plan": ["计划里还有步骤没做完", "Steps of its plan are still left"],
  "ui.next.line.blocker.execution": ["这一轮没做完，会接着做", "Not finished this round; it carries on"],
  "ui.next.line.blocker.empty_output": ["本轮已结束。请再问一次。", "This turn ended. Ask again."],
  "ui.next.line.blocker.failed": ["出错停下了，打开看是哪一步", "Stopped on an error; open it to see where"],
  "ui.next.line.blocker.model_auth_rejected": ["模型供应商拒绝了凭据", "The model provider rejected the credentials"],
};
