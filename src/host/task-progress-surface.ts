/** Channel cards resolve task progress at the host; agent-supplied numbers never enter this component. */
import type { A2uiMessage } from "./show-ui-catalog.ts";
import type { TaskProgressSummary } from "./task-progress.ts";
import { progressLines } from "./task-progress-view.ts";
export function taskProgressSurface(messages: readonly A2uiMessage[], read: (id: string) => TaskProgressSummary, locale: "zh" | "en" = "zh"): A2uiMessage[] {
  return messages.map(message => "updateComponents" in message ? { ...message, updateComponents: { ...message.updateComponents, components: message.updateComponents.components.map(component => {
    if (component.component !== "TaskProgress") return component;
    return { id: component.id, component: "Text", text: progressLines(typeof component.taskId === "string" ? read(component.taskId) : undefined, locale).join("\n") };
  }) } } : message);
}
