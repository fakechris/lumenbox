/**
 * A ShowUI card as a chat can carry it (docs/79 §3): the same A2UI messages the page
 * renders, read into lines of text and a row of buttons. Feishu draws the lines and the
 * buttons; a wire with no cards gets the lines and, for each button, the words to type.
 *
 * Nothing here is a renderer. Layout components are walked in order and flattened,
 * because a chat card is a column whatever the agent drew; a Button or a ChoicePicker
 * option becomes a press that speaks the same action line the page would send.
 */

import { type A2uiMessage, actionText } from "../host/show-ui-catalog.ts";

export interface SurfaceButton {
  label: string;
  /** The event name the agent wrote, or `choose` for a ChoicePicker option. */
  name: string;
  context?: Record<string, unknown>;
}

export interface SurfaceCardState {
  surfaceId: string;
  agentName: string;
  title?: string;
  /** The card's text, one line per component, in document order. */
  lines: string[];
  buttons: SurfaceButton[];
}

type Component = Record<string, unknown>;

/** The components and data a message list leaves on the surface, in document order from `root`. */
function componentsOf(messages: readonly A2uiMessage[]): { byId: Map<string, Component>; data: Record<string, unknown> } {
  const byId = new Map<string, Component>();
  let data: Record<string, unknown> = {};
  for (const message of messages) {
    if ("updateComponents" in message) {
      for (const component of message.updateComponents.components) {
        if (typeof component.id === "string") byId.set(component.id, component);
      }
    } else if ("updateDataModel" in message && message.updateDataModel.path === "/" && message.updateDataModel.value !== null && typeof message.updateDataModel.value === "object") {
      data = message.updateDataModel.value as Record<string, unknown>;
    } else if ("deleteSurface" in message) {
      byId.clear();
      data = {};
    }
  }
  return { byId, data };
}

/** A literal, or a `{path}` binding read from the data model; a function call reads as nothing. */
function resolve(value: unknown, data: Record<string, unknown>): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.path === "string") {
    const parts = record.path.split("/").filter(part => part !== "");
    let cursor: unknown = data;
    for (const part of parts) {
      if (cursor === null || typeof cursor !== "object") return undefined;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor;
  }
  return undefined;
}

function text(value: unknown, data: Record<string, unknown>): string {
  const resolved = resolve(value, data);
  if (resolved === undefined || resolved === null) return "";
  return Array.isArray(resolved) ? resolved.map(String).join(", ") : String(resolved);
}

/** Reads the surface into lines and buttons. Unknown components are skipped, not drawn wrong. */
export function surfaceCard(input: { surfaceId: string; agentName: string; title?: string; messages: readonly A2uiMessage[] }): SurfaceCardState {
  const { byId, data } = componentsOf(input.messages);
  const lines: string[] = [];
  const buttons: SurfaceButton[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const component = byId.get(id);
    if (component === undefined) return;
    // Only layout walks into its children: a Button's child is its label, drawn with the button.
    const layout = component.component === "Row" || component.component === "Column" || component.component === "List" || component.component === "Card";
    const children = (layout ? component.children ?? (typeof component.child === "string" ? [component.child] : []) : []) as unknown;
    switch (component.component) {
      case "Text": {
        const content = text(component.text, data);
        if (content === "") break;
        const variant = String(component.variant ?? "body");
        lines.push(variant.startsWith("h") ? `**${content}**` : content);
        break;
      }
      case "Divider":
        lines.push("---");
        break;
      case "Button": {
        const label = typeof component.child === "string" ? text(byId.get(component.child)?.text, data) : "";
        const event = ((component.action as Record<string, unknown> | undefined)?.event ?? undefined) as Record<string, unknown> | undefined;
        if (event !== undefined && typeof event.name === "string") {
          const context: Record<string, unknown> = {};
          for (const [key, value] of Object.entries((event.context as Record<string, unknown> | undefined) ?? {})) {
            const resolved = resolve(value, data);
            if (resolved !== undefined) context[key] = resolved;
          }
          buttons.push({ label: label || event.name, name: event.name, ...(Object.keys(context).length > 0 ? { context } : {}) });
        }
        break;
      }
      case "ChoicePicker": {
        const label = text(component.label, data);
        if (label !== "") lines.push(label);
        const options = Array.isArray(component.options) ? component.options : [];
        for (const option of options as Record<string, unknown>[]) {
          const optionLabel = text(option.label, data);
          const value = typeof option.value === "string" ? option.value : optionLabel;
          if (optionLabel === "") continue;
          lines.push(`· ${optionLabel}`);
          buttons.push({ label: optionLabel, name: "choose", context: { [id]: [value] } });
        }
        break;
      }
      case "Table": {
        // A chat gets the heading and the first rows as words; sorting and selection are the page's.
        const columns = (Array.isArray(component.columns) ? component.columns : []) as { key: string; label: string }[];
        const rows = resolve(component.rows, data);
        const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
        if (columns.length > 0) lines.push(columns.map(column => `**${column.label}**`).join(" | "));
        for (const row of list.slice(0, 8)) lines.push(columns.map(column => text(row?.[column.key], data)).join(" | "));
        if (list.length > 8) lines.push(`… ${list.length - 8} more rows in the app`);
        const caption = text(component.caption, data);
        if (caption !== "") lines.push(caption);
        break;
      }
      case "TextField": {
        const label = text(component.label, data);
        lines.push(`${label !== "" ? label : "…"}：在聊天里回复`);
        break;
      }
      case "CheckBox": {
        const label = text(component.label, data);
        const checked = resolve(component.value, data) === true;
        lines.push(`${checked ? "[x]" : "[ ]"} ${label}`);
        break;
      }
      default:
        break;
    }
    if (Array.isArray(children)) for (const child of children) if (typeof child === "string") walk(child);
  };
  walk("root");
  return { surfaceId: input.surfaceId, agentName: input.agentName, ...(input.title !== undefined ? { title: input.title } : {}), lines, buttons };
}

/** The press a button makes, as the line the agent receives. */
export function buttonText(card: SurfaceCardState, button: SurfaceButton): string {
  return actionText({ name: button.name, surfaceId: card.surfaceId, ...(button.context !== undefined ? { context: button.context } : {}) });
}

/** The card as words, for a wire with no cards: the lines, then each press as the text to send. */
export function surfaceText(card: SurfaceCardState): string {
  const head = card.title !== undefined ? `**${card.title}**\n` : "";
  const body = card.lines.join("\n");
  const presses = card.buttons.length > 0
    ? `\n\n${card.buttons.map(button => `${button.label}：回复 ${buttonText(card, button)}`).join("\n")}`
    : "";
  return `${head}${body}${presses}`.trim();
}
