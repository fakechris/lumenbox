/// <reference lib="dom" />
/**
 * The browser side of ShowUI (docs/79), bundled by scripts/build-vendor.mjs into
 * vendor/a2ui.js and served at /vendor/a2ui.js. The page loads it the first time a card
 * appears and reaches it as `window.A2UI`.
 *
 * It is the same catalog the host validates with — the same ten component names over
 * the Lit implementations — so what the host accepted, this renders.
 */

import { Catalog, MessageProcessor, STRICT_VALIDATION } from "@a2ui/web_core/v0_9";
import { basicCatalog } from "@a2ui/lit/v0_9";
import { injectBasicCatalogStyles } from "@a2ui/web_core/v0_9/basic_catalog";
import { registerUniversalElement } from "@a2ui/web_core/universal";
import { SHOW_UI_BASIC_COMPONENTS, SHOW_UI_CATALOG_ID, SHOW_UI_PROTOCOL } from "../host/show-ui-catalog.ts";
import { SHOW_UI_FUNCTIONS } from "../host/show-ui-functions.ts";
import { ApproveApi, CodeApi, MarkdownApi, ProgressApi, TableApi } from "../host/show-ui-components.ts";
import { LumenboxTableElement } from "./a2ui-table.ts";
import { LumenboxProgressElement } from "./a2ui-progress.ts";
import { LumenboxCodeElement, LumenboxMarkdownElement } from "./a2ui-markdown.ts";
import { LumenboxApproveElement } from "./a2ui-approve.ts";

const names = new Set(SHOW_UI_BASIC_COMPONENTS);
// lumenbox's own elements (INV-1280): the same schema the host validated with, paired with
// the element that draws it, registered once.
const lumenbox = [
  { ...TableApi, tagName: LumenboxTableElement.tagName, element: LumenboxTableElement },
  { ...ProgressApi, tagName: LumenboxProgressElement.tagName, element: LumenboxProgressElement },
  { ...MarkdownApi, tagName: LumenboxMarkdownElement.tagName, element: LumenboxMarkdownElement },
  { ...CodeApi, tagName: LumenboxCodeElement.tagName, element: LumenboxCodeElement },
  { ...ApproveApi, tagName: LumenboxApproveElement.tagName, element: LumenboxApproveElement },
];
for (const component of lumenbox) registerUniversalElement(component);
const catalog = new Catalog(
  SHOW_UI_CATALOG_ID,
  SHOW_UI_PROTOCOL,
  [...[...basicCatalog.components.values()].filter(component => names.has(component.name)), ...lumenbox],
  [...basicCatalog.functions.values()].filter(fn => SHOW_UI_FUNCTIONS.includes(fn.name))
);

injectBasicCatalogStyles(document);

declare global {
  interface Window {
    A2UI: { MessageProcessor: typeof MessageProcessor; catalog: typeof catalog; validation: typeof STRICT_VALIDATION };
  }
}

window.A2UI = { MessageProcessor, catalog, validation: STRICT_VALIDATION };
