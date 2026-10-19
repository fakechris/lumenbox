/// <reference lib="dom" />
/**
 * The small lumenbox components (INV-1286): Badge, KeyValue, Stat, Callout, Link. What an
 * agent reaches for to say "status", "numbers", "key: value", "mind this" and "here" — the
 * things it was faking with bold Text. Light DOM, styled by the page's `.surface` rules.
 */

import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { A2uiLitElement } from "@a2ui/web_core/universal";
import { BadgeApi, CalloutApi, KeyValueApi, LinkApi, StatApi } from "../host/show-ui-components.ts";

type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

/** A status word's colour when the agent gave none: done/open/blocked read as what they are. */
export function toneOf(value: unknown, given?: string): Tone {
  if (given === "ok" || given === "warn" || given === "danger" || given === "info" || given === "neutral") return given;
  const word = String(value ?? "").toLowerCase();
  if (/^(done|ok|pass|passed|green|merged|accepted|success|complete|completed|live|active)$/.test(word)) return "ok";
  if (/^(blocked|failed|fail|error|danger|red|rejected|overdue|down)$/.test(word)) return "danger";
  if (/^(review|doing|pending|waiting|warn|warning|yellow|stale|in progress|running)$/.test(word)) return "warn";
  if (/^(open|todo|new|info|queued|planned|draft)$/.test(word)) return "info";
  return "neutral";
}

export function badge(text: unknown, tone?: string): TemplateResult {
  return html`<span class=${`lb-badge lb-tone-${toneOf(text, tone)}`}>${String(text ?? "")}</span>`;
}

/** Where a Link goes, and how the page should treat it. */
export function linkTarget(to: string): { href: string; kind: "file" | "task" | "url"; host?: string } {
  if (to.startsWith("/")) return { href: `/api/file?path=${encodeURIComponent(to)}`, kind: "file" };
  if (/^t\d+$/.test(to)) return { href: `#task=${to}`, kind: "task" };
  try { return { href: to, kind: "url", host: new URL(to).host }; } catch { return { href: "#", kind: "url" }; }
}

export class LumenboxBadgeElement extends A2uiLitElement<typeof BadgeApi> {
  static readonly tagName = "lumenbox-badge";
  protected override readonly api = BadgeApi;
  override createRenderRoot() { return this; }
  override render(): TemplateResult | typeof nothing {
    const props = this.controller?.props as unknown as { text?: string; tone?: string } | undefined;
    if (!props) return nothing;
    return badge(props.text, props.tone);
  }
}

export class LumenboxKeyValueElement extends A2uiLitElement<typeof KeyValueApi> {
  static readonly tagName = "lumenbox-keyvalue";
  protected override readonly api = KeyValueApi;
  override createRenderRoot() { return this; }
  override render(): TemplateResult | typeof nothing {
    const props = this.controller?.props as unknown as { items?: unknown } | undefined;
    if (!props) return nothing;
    const items = (Array.isArray(props.items) ? props.items : []).filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
    return html`<dl class="lb-kv">${items.map(item => html`<dt>${String(item.key ?? "")}</dt><dd>${item.tone !== undefined ? badge(item.value, String(item.tone)) : String(item.value ?? "")}</dd>`)}</dl>`;
  }
}

export class LumenboxStatElement extends A2uiLitElement<typeof StatApi> {
  static readonly tagName = "lumenbox-stat";
  protected override readonly api = StatApi;
  override createRenderRoot() { return this; }
  override render(): TemplateResult | typeof nothing {
    const props = this.controller?.props as unknown as { label?: string; value?: string; unit?: string; delta?: string; tone?: string } | undefined;
    if (!props) return nothing;
    const tone = props.tone ?? "neutral";
    const delta = props.delta ?? "";
    const deltaTone = delta.startsWith("-") ? "danger" : delta.startsWith("+") ? "ok" : "neutral";
    return html`
      <div class=${`lb-stat lb-tone-${tone}`}>
        <div class="lb-stat-value">${props.value ?? ""}${props.unit ? html`<span class="lb-stat-unit">${props.unit}</span>` : nothing}${delta ? html` <span class=${`lb-stat-delta lb-tone-${deltaTone}`}>${delta}</span>` : nothing}</div>
        <div class="lb-stat-label">${props.label ?? ""}</div>
      </div>`;
  }
}

declare global {
  interface Window { markdownit?: (options: Record<string, unknown>) => { render: (text: string) => string } }
}
let renderer: { render: (text: string) => string } | null | undefined;

export class LumenboxCalloutElement extends A2uiLitElement<typeof CalloutApi> {
  static readonly tagName = "lumenbox-callout";
  protected override readonly api = CalloutApi;
  override createRenderRoot() { return this; }
  override render(): TemplateResult | typeof nothing {
    const props = this.controller?.props as unknown as { tone?: string; title?: string; text?: string } | undefined;
    if (!props) return nothing;
    if (renderer === undefined) renderer = typeof window.markdownit === "function" ? window.markdownit({ html: false, linkify: true, breaks: true }) : null;
    const text = String(props.text ?? "");
    return html`
      <div class=${`lb-callout lb-tone-${props.tone ?? "info"}`}>
        ${props.title ? html`<div class="lb-callout-title">${props.title}</div>` : nothing}
        ${renderer === null ? html`<div class="lb-callout-text">${text}</div>` : html`<div class="lb-callout-text md">${unsafeHTML(renderer.render(text))}</div>`}
      </div>`;
  }
}

export class LumenboxLinkElement extends A2uiLitElement<typeof LinkApi> {
  static readonly tagName = "lumenbox-link";
  protected override readonly api = LinkApi;
  override createRenderRoot() { return this; }
  override render(): TemplateResult | typeof nothing {
    const props = this.controller?.props as unknown as { text?: string; to?: string } | undefined;
    if (!props || !props.to) return nothing;
    const target = linkTarget(props.to);
    const external = target.kind === "url";
    return html`<a class=${`lb-link lb-link-${target.kind}`} href=${target.href} target=${external ? "_blank" : "_self"} rel=${external ? "noopener" : ""} title=${props.to}>${props.text ?? props.to}${external && target.host ? html` <span class="lb-link-host">${target.host}</span>` : nothing}</a>`;
  }
}
