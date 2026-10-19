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
import { SHOW_UI_CATALOG_ID, SHOW_UI_COMPONENTS, SHOW_UI_PROTOCOL } from "../host/show-ui-catalog.ts";

const names = new Set(SHOW_UI_COMPONENTS);
const catalog = new Catalog(
  SHOW_UI_CATALOG_ID,
  SHOW_UI_PROTOCOL,
  [...basicCatalog.components.values()].filter(component => names.has(component.name))
);

injectBasicCatalogStyles(document);

declare global {
  interface Window {
    A2UI: { MessageProcessor: typeof MessageProcessor; catalog: typeof catalog; validation: typeof STRICT_VALIDATION };
  }
}

window.A2UI = { MessageProcessor, catalog, validation: STRICT_VALIDATION };
