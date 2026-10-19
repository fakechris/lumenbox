/// <reference lib="dom" />
/**
 * The Table element (INV-1280): what the agent most often has to show a person and the basic
 * catalog does not have. Light DOM, so the page's own typography applies; sorting is the
 * element's own state, selection is the data model's (`props.setValue`), which is how a
 * Button's bound context carries the chosen rows back to the agent.
 */

import { html, nothing, css, type TemplateResult } from "lit";
import { A2uiLitElement } from "@a2ui/web_core/universal";
import { TableApi } from "../host/show-ui-components.ts";

type Row = Record<string, unknown>;

export class LumenboxTableElement extends A2uiLitElement<typeof TableApi> {
  static readonly tagName = "lumenbox-table";
  protected override readonly api = TableApi;
  private sortBy: string | undefined;
  private sortDesc = false;

  static override styles = css`
    :host { display: block; }
  `;

  /** Light DOM: the page's CSS reaches the table, and the table reaches the page's variables. */
  override createRenderRoot() { return this; }

  override render(): TemplateResult | typeof nothing {
    const props = this.controller?.props as unknown as {
      columns: { key: string; label: string; align?: "start" | "end" }[];
      rows: unknown;
      rowKey?: string;
      selectable?: boolean;
      value?: string[];
      setValue?: (value: string[]) => void;
      sortable?: boolean;
      caption?: string;
    } | undefined;
    if (!props) return nothing;
    const columns = props.columns ?? [];
    const keyField = props.rowKey ?? columns[0]?.key ?? "id";
    const rows: Row[] = Array.isArray(props.rows) ? (props.rows as unknown[]).filter((row): row is Row => row !== null && typeof row === "object") : [];
    const sortable = props.sortable !== false;
    const sorted = this.sortBy === undefined ? rows : [...rows].sort((a, b) => {
      const x = a[this.sortBy!]; const y = b[this.sortBy!];
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true });
      return this.sortDesc ? -cmp : cmp;
    });
    const selected = new Set(Array.isArray(props.value) ? props.value.map(String) : []);
    const keyOf = (row: Row): string => String(row[keyField] ?? "");
    const toggle = (row: Row) => {
      const key = keyOf(row);
      const next = new Set(selected);
      if (next.has(key)) next.delete(key); else next.add(key);
      props.setValue?.([...next]);
    };
    const toggleAll = () => {
      const all = sorted.map(keyOf);
      props.setValue?.(all.every(key => selected.has(key)) ? [] : all);
    };
    const sortOn = (key: string) => {
      if (!sortable) return;
      if (this.sortBy === key) this.sortDesc = !this.sortDesc; else { this.sortBy = key; this.sortDesc = false; }
      this.requestUpdate();
    };
    return html`
      <table class="lb-table">
        <thead><tr>
          ${props.selectable ? html`<th class="lb-sel"><input type="checkbox" .checked=${sorted.length > 0 && sorted.every(row => selected.has(keyOf(row)))} @change=${toggleAll} title="all"></th>` : nothing}
          ${columns.map(column => html`<th class=${column.align === "end" ? "lb-end" : ""} @click=${() => sortOn(column.key)} style=${sortable ? "cursor:pointer" : ""}>${column.label}${this.sortBy === column.key ? (this.sortDesc ? " ↓" : " ↑") : ""}</th>`)}
        </tr></thead>
        <tbody>
          ${sorted.map(row => html`<tr class=${selected.has(keyOf(row)) ? "lb-picked" : ""}>
            ${props.selectable ? html`<td class="lb-sel"><input type="checkbox" .checked=${selected.has(keyOf(row))} @change=${() => toggle(row)}></td>` : nothing}
            ${columns.map(column => html`<td class=${column.align === "end" ? "lb-end" : ""}>${cell(row[column.key])}</td>`)}
          </tr>`)}
          ${sorted.length === 0 ? html`<tr><td class="lb-empty" colspan=${columns.length + (props.selectable ? 1 : 0)}>—</td></tr>` : nothing}
        </tbody>
        ${props.caption ? html`<caption>${props.caption}</caption>` : nothing}
      </table>`;
  }
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
