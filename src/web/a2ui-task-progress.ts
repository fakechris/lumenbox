/// <reference lib="dom" />
/** Canonical task progress; props choose a task, never supply progress numbers. Offscreen cards do no polling. */
import { html, nothing } from "lit";
import { A2uiLitElement } from "@a2ui/web_core/universal";
import { TaskProgressApi } from "../host/show-ui-components.ts";
import { progressLines } from "../host/task-progress-view.ts";
import type { TaskProgressSummary } from "../host/task-progress.ts";

export class LumenboxTaskProgressElement extends A2uiLitElement<typeof TaskProgressApi> {
  static readonly tagName = "lumenbox-task-progress";
  protected override readonly api = TaskProgressApi;
  private taskId = "";
  private progress: TaskProgressSummary;
  private generation = 0;
  private controllerRequest?: AbortController;
  private observer?: IntersectionObserver;
  private visible = false;
  private poll?: ReturnType<typeof setInterval>;
  private queued?: ReturnType<typeof setTimeout>;
  private readonly changed = (event: Event) => {
    if (event.type === "lumen-task-progress" && (event as CustomEvent<{ taskId: string }>).detail?.taskId !== this.taskId) return;
    if (!this.visible || this.queued) return;
    this.queued = setTimeout(() => { this.queued = undefined; void this.read(); }, 250);
  };
  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback(); this.requestUpdate();
    this.observer = new IntersectionObserver(entries => {
      this.visible = entries.some(entry => entry.isIntersecting);
      if (this.visible) void this.read();
    });
    this.observer.observe(this);
    window.addEventListener("lumen-task-progress", this.changed);
    window.addEventListener("lumen-connection", this.changed);
    this.poll = setInterval(() => { if (this.visible && document.visibilityState !== "hidden") void this.read(); }, 8000);
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    this.observer?.disconnect(); this.controllerRequest?.abort(); this.generation++;
    clearInterval(this.poll); clearTimeout(this.queued); this.queued = undefined;
    window.removeEventListener("lumen-task-progress", this.changed);
    window.removeEventListener("lumen-connection", this.changed);
    this.taskId = ""; this.progress = undefined; this.visible = false;
  }
  protected override updated() {
    const id = String(this.controller?.props.taskId ?? "");
    if (id !== this.taskId) { this.taskId = id; this.progress = undefined; this.generation++; this.controllerRequest?.abort(); if (this.visible) void this.read(); }
  }
  private async read() {
    if (!this.taskId || !this.isConnected || !this.visible || document.visibilityState === "hidden") return;
    const generation = ++this.generation, id = this.taskId;
    this.controllerRequest?.abort(); this.controllerRequest = new AbortController();
    try {
      const response = await fetch("/api/tasks/item?task=" + encodeURIComponent(id), { signal: this.controllerRequest.signal });
      const body = await response.json();
      if (generation !== this.generation || !this.isConnected || id !== this.taskId) return;
      this.progress = response.ok ? body.task?.progress : undefined;
    } catch (error) { if ((error as Error).name === "AbortError" || generation !== this.generation) return; this.progress = undefined; }
    this.requestUpdate();
  }
  override render() {
    if (!this.controller?.props.taskId) return nothing;
    return html`<div class="lb-progress">${progressLines(this.progress, document.documentElement.lang === "en" ? "en" : "zh").map(line => html`<p class="dim">${line}</p>`)}</div>`;
  }
}
