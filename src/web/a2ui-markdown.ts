/// <reference lib="dom" />
/**
 * Markdown and Code elements (INV-1280). Markdown renders through the page's markdown-it
 * (html off, the same renderer and options as every chat message — docs/41), falling back
 * to escaped text where the page has none. Code is a block with a copy button; the diff
 * variant colours added and removed lines.
 */

import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { A2uiLitElement } from "@a2ui/web_core/universal";
import { CodeApi, MarkdownApi } from "../host/show-ui-components.ts";

declare global {
  interface Window { markdownit?: (options: Record<string, unknown>) => { render: (text: string) => string } }
}

let renderer: { render: (text: string) => string } | null | undefined;
function markdown(text: string): string | undefined {
  if (renderer === undefined) renderer = typeof window.markdownit === "function" ? window.markdownit({ html: false, linkify: true, breaks: true }) : null;
  return renderer === null ? undefined : renderer.render(text);
}

export class LumenboxMarkdownElement extends A2uiLitElement<typeof MarkdownApi> {
  static readonly tagName = "lumenbox-markdown";
  protected override readonly api = MarkdownApi;
  override createRenderRoot() { return this; }
  override render(): TemplateResult | typeof nothing {
    const props = this.controller?.props as unknown as { text?: string } | undefined;
    if (!props) return nothing;
    const text = String(props.text ?? "");
    const rendered = markdown(text);
    return rendered === undefined
      ? html`<div class="lb-markdown"><pre class="lb-markdown-plain">${text}</pre></div>`
      : html`<div class="lb-markdown md">${unsafeHTML(rendered)}</div>`;
  }
}

export class LumenboxCodeElement extends A2uiLitElement<typeof CodeApi> {
  static readonly tagName = "lumenbox-code";
  protected override readonly api = CodeApi;
  private copied = false;
  override createRenderRoot() { return this; }
  override render(): TemplateResult | typeof nothing {
    const props = this.controller?.props as unknown as { text?: string; language?: string; variant?: string; title?: string } | undefined;
    if (!props) return nothing;
    const text = String(props.text ?? "");
    const copy = async () => {
      try { await navigator.clipboard.writeText(text); this.copied = true; this.requestUpdate(); setTimeout(() => { this.copied = false; this.requestUpdate(); }, 1500); } catch { /* no clipboard here */ }
    };
    const lines = text.split("\n");
    return html`
      <div class="lb-code">
        <div class="lb-code-head">
          <span class="lb-code-title">${props.title ?? props.language ?? ""}</span>
          <button type="button" class="btn sm ghost" @click=${copy}>${this.copied ? "copied" : "copy"}</button>
        </div>
        ${props.variant === "diff"
          ? html`<pre class="lb-code-body lb-diff">${lines.map(line => html`<span class=${line.startsWith("+") ? "lb-add" : line.startsWith("-") ? "lb-del" : line.startsWith("@@") ? "lb-hunk" : ""}>${line}\n</span>`)}</pre>`
          : html`<pre class="lb-code-body"><code class=${props.language ? `language-${props.language}` : ""}>${text}</code></pre>`}
      </div>`;
  }
}
