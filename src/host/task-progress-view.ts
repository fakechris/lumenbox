/** The same source-labelled words for the task workspace, A2UI and channel cards. No browser or Node dependencies. */
import type { TaskProgressSummary } from "./task-progress.ts";
export function progressLines(progress: TaskProgressSummary, locale: "zh" | "en" = "zh"): string[] {
  const zh = locale === "zh";
  if (!progress?.sources.length) return [zh ? "当前只有活动/阶段，业务进度暂无可用来源。" : "Activity/stage only; no business progress source is available."];
  const labels = zh ? { "agent-reported": "执行者报告", "job-observed": "受信作业记录", "independent-verifier": "独立核验报告" } : { "agent-reported": "Executor report", "job-observed": "Trusted job record", "independent-verifier": "Independent verifier report" };
  const lines = progress.sources.flatMap(source => {
    const head = labels[source.source] + " · " + source.stage + (source.stale ? zh ? "（旧范围/旧工作）" : " (earlier scope/work)" : "");
    const body = source.source === "independent-verifier"
      ? head + ": " + (zh ? "匹配报告版本的独立核验 " : "Version-matched independent checks ") + (source.verified ?? 0) + " " + source.unit + "; " + (zh ? "未匹配/待重验 " : "unmatched/needs recheck ") + (source.verificationUnmatched ?? 0)
      : head + ": " + (zh ? "已处理 " : "processed ") + source.processed + (source.total === null ? zh ? "（总量未知）" : " (total unknown)" : "/" + source.total) + " " + source.unit + "; " + (zh ? "成功 " : "succeeded ") + source.succeeded + ", " + (zh ? "失败 " : "failed ") + source.failed + ", " + (zh ? "跳过 " : "skipped ") + source.skipped + ", " + (zh ? "未知 " : "unknown ") + source.unknown + (source.basis === "producer-counts" ? zh ? "（生产者计数，无对象ID）" : " (producer counts; no object IDs)" : "");
    return [body, source.agentId + " · " + source.observedAt + " · " + source.sourceRef];
  });
  if (progress.omittedSources) lines.push((zh ? "另有来源报告，打开任务查看：" : "Additional source reports; open the task: ") + progress.omittedSources);
  if (!progress.sources.some(source => source.source === "independent-verifier")) lines.push(zh ? "尚无独立核验覆盖报告。" : "No independent verification coverage has been reported.");
  lines.push(zh ? "各来源和阶段单独计数；这些报告不代表任务完成或人工接受。" : "Sources/stages are counted separately; these reports do not mean task completion or human acceptance.");
  return lines;
}
export const TASK_PROGRESS_CLIENT_JS = `${progressLines.toString()}\nwindow.taskProgressHtml = function (task) {
  var lines = progressLines(task.progress,typeof MSG_LOCALE === "string" && MSG_LOCALE === "en" ? "en" : "zh");
  return lines.map(function (line) { return '<p class="tf-note">' + esc(line) + '</p>'; }).join("");
};`;
