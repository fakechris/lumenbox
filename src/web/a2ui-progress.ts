/// <reference lib="dom" />
/**
 * The Progress element (INV-1280): steps with a status each and/or a bar. Everything it shows
 * comes from props, so an agent's `ShowUI({surface, data})` between tool calls moves it
 * without the card being rebuilt.
 */

import { html, nothing, type TemplateResult } from "lit";
import { A2uiLitElement } from "@a2ui/web_core/universal";
import { ProgressApi } from "../host/show-ui-components.ts";

type Step = { label?: unknown; status?: unknown; note?: unknown };
const MARK: Record<string, string> = { todo: "○", doing: "◐", done: "●", failed: "✕", skipped: "–" };

export class LumenboxProgressElement extends A2uiLitElement<typeof ProgressApi> {
  static readonly tagName = "lumenbox-progress";
  protected override readonly api = ProgressApi;

  override createRenderRoot() { return this; }

  override render(): TemplateResult | typeof nothing {
    const props = this.controller?.props as unknown as { title?: string; steps?: unknown; value?: number; label?: string } | undefined;
    if (!props) return nothing;
    const steps: Step[] = Array.isArray(props.steps) ? (props.steps as unknown[]).filter((step): step is Step => step !== null && typeof step === "object") : [];
    const done = steps.filter(step => step.status === "done").length;
    const percent = typeof props.value === "number"
      ? Math.max(0, Math.min(100, props.value))
      : steps.length > 0 ? Math.round((done / steps.length) * 100) : undefined;
    return html`
      <div class="lb-progress">
        ${props.title ? html`<div class="lb-progress-title">${props.title}${steps.length > 0 ? html` <span class="dim">${done}/${steps.length}</span>` : nothing}</div>` : nothing}
        ${percent !== undefined ? html`<div class="lb-bar" role="progressbar" aria-valuenow=${percent}><div class="lb-bar-fill" style="width:${percent}%"></div></div>` : nothing}
        ${steps.length > 0 ? html`<ol class="lb-steps">${steps.map(step => html`<li class="lb-step lb-step-${String(step.status ?? "todo")}"><span class="lb-mark">${MARK[String(step.status ?? "todo")] ?? "○"}</span> ${String(step.label ?? "")}${step.note ? html` <span class="dim">${String(step.note)}</span>` : nothing}</li>`)}</ol>` : nothing}
        ${props.label ? html`<div class="lb-progress-label dim">${props.label}</div>` : nothing}
      </div>`;
  }
}
