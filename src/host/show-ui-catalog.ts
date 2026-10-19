/**
 * What the host and the page agree on about ShowUI cards, with no Node in it: this file
 * is bundled into the browser (src/web/a2ui-entry.ts) as well as imported by the host.
 */

export const SHOW_UI_CATALOG_ID = "https://lumenbox.dev/a2ui/catalog.json";
export const SHOW_UI_PROTOCOL = "v0.9";

/** The components a card may use, in the order the basic catalog lists them. */
/** The basic-catalog components a card may use, in the order the catalog lists them. */
export const SHOW_UI_BASIC_COMPONENTS: readonly string[] = [
  "Text", "Row", "Column", "List", "Card", "Divider", "Button", "TextField", "CheckBox", "ChoicePicker",
];

/** lumenbox's own (INV-1280), schemas in show-ui-components.ts. */
export const SHOW_UI_LUMENBOX_COMPONENTS: readonly string[] = ["Table", "Progress", "Markdown", "Code", "Approve"];

/** Every component a card may use. */
export const SHOW_UI_COMPONENTS: readonly string[] = [...SHOW_UI_BASIC_COMPONENTS, ...SHOW_UI_LUMENBOX_COMPONENTS];

/** The component the surface renders first; A2UI's convention, made a rule here. */
export const SHOW_UI_ROOT = "root";

/** One A2UI v0.9 server-to-client message, as the page's processor takes it. */
export type A2uiMessage =
  | { version: "v0.9"; createSurface: { surfaceId: string; catalogId: string } }
  | { version: "v0.9"; updateComponents: { surfaceId: string; components: Record<string, unknown>[] } }
  | { version: "v0.9"; updateDataModel: { surfaceId: string; path: string; value: unknown } }
  | { version: "v0.9"; deleteSurface: { surfaceId: string } };

/** What a ShowUI call draws, as the page draws it on replay; nothing here validates. */
export interface SurfaceDraw {
  surfaceId: string;
  title?: string;
  messages: A2uiMessage[];
  close?: boolean;
}

/**
 * The messages one ShowUI call stands for, from its raw input. The page replays a
 * transcript from these; the live path sends the same shape after validation. An input
 * that could not have been accepted (no components, no surface) yields nothing.
 */
export function surfaceDrawOf(input: unknown): SurfaceDraw | undefined {
  const args = (input ?? {}) as { surface?: unknown; components?: unknown; data?: unknown; title?: unknown; close?: unknown };
  const surfaceId = typeof args.surface === "string" ? args.surface.trim() : "";
  if (surfaceId === "") return undefined;
  const title = typeof args.title === "string" && args.title.trim() !== "" ? args.title.trim() : undefined;
  if (args.close === true) {
    return { surfaceId, ...(title !== undefined ? { title } : {}), messages: [{ version: "v0.9", deleteSurface: { surfaceId } }], close: true };
  }
  if (!Array.isArray(args.components) || args.components.length === 0) return undefined;
  const components = args.components.filter((component): component is Record<string, unknown> => component !== null && typeof component === "object" && !Array.isArray(component));
  const messages: A2uiMessage[] = [
    { version: "v0.9", createSurface: { surfaceId, catalogId: SHOW_UI_CATALOG_ID } },
    { version: "v0.9", updateComponents: { surfaceId, components } },
  ];
  if (args.data !== null && typeof args.data === "object" && !Array.isArray(args.data)) {
    messages.push({ version: "v0.9", updateDataModel: { surfaceId, path: "/", value: args.data } });
  }
  return { surfaceId, ...(title !== undefined ? { title } : {}), messages };
}

/** How a person's press on a card reaches the agent: as one line of an ordinary message. */
export function actionText(action: { name: string; surfaceId: string; context?: Record<string, unknown> }): string {
  const context = action.context !== undefined && Object.keys(action.context).length > 0 ? `: ${JSON.stringify(action.context)}` : "";
  return `[Action "${action.name}" on card ${action.surfaceId}${context}]`;
}
