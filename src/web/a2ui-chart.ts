/// <reference lib="dom" />
/**
 * The Chart element (INV-1280): bars or a line, as inline SVG from the points in props.
 * Nothing is fetched and nothing is scripted; a point's value moves when the data model does.
 */

import { html, nothing, svg, type TemplateResult } from "lit";
import { A2uiLitElement } from "@a2ui/web_core/universal";
import { ChartApi } from "../host/show-ui-components.ts";

type Point = { label: string; value: number };

export class LumenboxChartElement extends A2uiLitElement<typeof ChartApi> {
  static readonly tagName = "lumenbox-chart";
  protected override readonly api = ChartApi;
  override createRenderRoot() { return this; }

  override render(): TemplateResult | typeof nothing {
    const props = this.controller?.props as unknown as { kind?: string; title?: string; points?: unknown; unit?: string; height?: number } | undefined;
    if (!props) return nothing;
    const points: Point[] = (Array.isArray(props.points) ? props.points : [])
      .map((raw: unknown) => raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : { label: "", value: raw })
      .map(raw => ({ label: String(raw.label ?? ""), value: Number(raw.value) }))
      .filter(point => Number.isFinite(point.value));
    const height = props.height ?? 160;
    const width = 560;
    const pad = { top: 12, right: 12, bottom: 28, left: 40 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const max = Math.max(0, ...points.map(point => point.value));
    const min = Math.min(0, ...points.map(point => point.value));
    const span = max - min || 1;
    const y = (value: number) => pad.top + innerH - ((value - min) / span) * innerH;
    const unit = props.unit ?? "";
    const fmt = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(1)}${unit}`;
    const n = points.length;
    const body = props.kind === "line"
      ? svg`
        <polyline fill="none" stroke="var(--accent, #17e)" stroke-width="2"
          points=${points.map((point, i) => `${pad.left + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2)},${y(point.value)}`).join(" ")}></polyline>
        ${points.map((point, i) => { const cx = pad.left + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2); return svg`
          <circle cx=${cx} cy=${y(point.value)} r="3" fill="var(--accent, #17e)"><title>${point.label}: ${fmt(point.value)}</title></circle>
          <text x=${cx} y=${height - 8} text-anchor="middle" class="lb-chart-label">${point.label}</text>`; })}`
      : svg`
        ${points.map((point, i) => { const slot = innerW / Math.max(1, n); const bw = Math.max(4, slot * 0.6); const x = pad.left + i * slot + (slot - bw) / 2; const top = y(Math.max(0, point.value)); const bottom = y(Math.min(0, point.value)); return svg`
          <rect x=${x} y=${top} width=${bw} height=${Math.max(1, bottom - top)} rx="2" fill="var(--accent, #17e)"><title>${point.label}: ${fmt(point.value)}</title></rect>
          <text x=${x + bw / 2} y=${top - 3} text-anchor="middle" class="lb-chart-value">${fmt(point.value)}</text>
          <text x=${x + bw / 2} y=${height - 8} text-anchor="middle" class="lb-chart-label">${point.label}</text>`; })}`;
    return html`
      <div class="lb-chart">
        ${props.title ? html`<div class="lb-chart-title">${props.title}</div>` : nothing}
        <svg viewBox="0 0 ${width} ${height}" width="100%" height=${height} role="img" aria-label=${props.title ?? "chart"}>
          <line x1=${pad.left} y1=${y(0)} x2=${width - pad.right} y2=${y(0)} stroke="var(--border, #ddd)"></line>
          <text x=${pad.left - 6} y=${pad.top + 4} text-anchor="end" class="lb-chart-axis">${fmt(max)}</text>
          ${min < 0 ? svg`<text x=${pad.left - 6} y=${pad.top + innerH} text-anchor="end" class="lb-chart-axis">${fmt(min)}</text>` : nothing}
          ${body}
        </svg>
      </div>`;
  }
}
