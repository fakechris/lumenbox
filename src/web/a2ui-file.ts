/// <reference lib="dom" />
/**
 * The FilePreview element (INV-1280): a file in the box, as a link through the page's own
 * `/api/file` route (the same door the Files panel uses, with the same work-directory guard)
 * and, for text, its first lines fetched once. An image shows as itself; anything else is
 * the link.
 */

import { html, nothing, type TemplateResult } from "lit";
import { A2uiLitElement } from "@a2ui/web_core/universal";
import { FilePreviewApi } from "../host/show-ui-components.ts";

type Loaded = { kind: "text"; lines: string[]; total: number } | { kind: "image" } | { kind: "other"; type: string } | { kind: "missing"; error: string };

export class LumenboxFilePreviewElement extends A2uiLitElement<typeof FilePreviewApi> {
  static readonly tagName = "lumenbox-file";
  protected override readonly api = FilePreviewApi;
  private loaded: Loaded | undefined;
  private loadedFor: string | undefined;
  override createRenderRoot() { return this; }

  private url(path: string, download = false): string {
    return `/api/file?${download ? "download=1&" : ""}path=${encodeURIComponent(path)}`;
  }

  private load(path: string, lines: number) {
    if (this.loadedFor === path) return;
    this.loadedFor = path;
    this.loaded = undefined;
    if (lines === 0) return;
    void fetch(this.url(path)).then(async response => {
      if (!response.ok) { this.loaded = { kind: "missing", error: `${response.status}` }; this.requestUpdate(); return; }
      const type = response.headers.get("content-type") ?? "";
      if (type.startsWith("image/")) this.loaded = { kind: "image" };
      else if (type.startsWith("text/") || /json|xml|javascript|yaml|csv/.test(type)) {
        const text = await response.text();
        const all = text.split("\n");
        this.loaded = { kind: "text", lines: all.slice(0, lines), total: all.length };
      } else this.loaded = { kind: "other", type };
      this.requestUpdate();
    }).catch(error => { this.loaded = { kind: "missing", error: error instanceof Error ? error.message : String(error) }; this.requestUpdate(); });
  }

  override render(): TemplateResult | typeof nothing {
    const props = this.controller?.props as unknown as { path?: string; title?: string; lines?: number } | undefined;
    if (!props || !props.path) return nothing;
    const path = props.path;
    const lines = props.lines ?? 20;
    this.load(path, lines);
    const name = props.title ?? path.split("/").pop() ?? path;
    const loaded = this.loaded;
    return html`
      <div class="lb-file">
        <div class="lb-file-head">
          <a class="lb-file-name" href=${this.url(path)} target="_blank" rel="noopener" title=${path}>${name}</a>
          <a class="btn sm ghost" href=${this.url(path, true)}>download</a>
        </div>
        ${loaded === undefined ? (lines === 0 ? nothing : html`<div class="dim">loading…</div>`)
          : loaded.kind === "text" ? html`<pre class="lb-file-body">${loaded.lines.join("\n")}${loaded.total > loaded.lines.length ? `\n… ${loaded.total - loaded.lines.length} more lines` : ""}</pre>`
          : loaded.kind === "image" ? html`<img class="lb-file-image" src=${this.url(path)} alt=${name}>`
          : loaded.kind === "other" ? html`<div class="dim">${loaded.type}</div>`
          : html`<div class="dim">not readable (${loaded.error})</div>`}
      </div>`;
  }
}
