/// <reference lib="dom" />
/**
 * The Approve element (INV-1280): allow and reject, always drawn the same way. The two
 * actions arrive resolved like a Button's; the host filled them in when the agent left them
 * out, so the agent's usual card is just a title and a line.
 */

import { html, nothing, type TemplateResult } from "lit";
import { A2uiLitElement } from "@a2ui/web_core/universal";
import { ApproveApi } from "../host/show-ui-components.ts";

export class LumenboxApproveElement extends A2uiLitElement<typeof ApproveApi> {
  static readonly tagName = "lumenbox-approve";
  protected override readonly api = ApproveApi;
  private pressed: "approve" | "reject" | undefined;
  override createRenderRoot() { return this; }
  override render(): TemplateResult | typeof nothing {
    const props = this.controller?.props as unknown as {
      title?: string; detail?: string; approveLabel?: string; rejectLabel?: string;
      onApprove?: () => Promise<void>; onReject?: () => Promise<void>;
    } | undefined;
    if (!props) return nothing;
    const press = (which: "approve" | "reject") => {
      if (this.pressed !== undefined) return;
      this.pressed = which; this.requestUpdate();
      void (which === "approve" ? props.onApprove : props.onReject)?.();
    };
    return html`
      <div class="lb-approve">
        ${props.title ? html`<div class="lb-approve-title">${props.title}</div>` : nothing}
        ${props.detail ? html`<div class="lb-approve-detail">${props.detail}</div>` : nothing}
        <div class="lb-approve-row">
          <button type="button" class=${`btn sm accent${this.pressed === "approve" ? " chosen" : ""}`} ?disabled=${this.pressed !== undefined} @click=${() => press("approve")}>${props.approveLabel ?? "Allow"}</button>
          <button type="button" class=${`btn sm ghost${this.pressed === "reject" ? " chosen" : ""}`} ?disabled=${this.pressed !== undefined} @click=${() => press("reject")}>${props.rejectLabel ?? "Reject"}</button>
          ${this.pressed ? html`<span class="dim">${this.pressed === "approve" ? "allowed" : "rejected"}</span>` : nothing}
        </div>
      </div>`;
  }
}
