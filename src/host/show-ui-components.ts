/**
 * lumenbox's own ShowUI components (docs/79 §3, INV-1280): the schemas, shared by the host
 * (validation) and the page (rendering), with no DOM in this file. The elements that draw
 * them live in src/web/a2ui-*.ts; a chat gets the words from src/channels/surface-card.ts.
 *
 * Each schema is strict: a property the agent invents is refused with its name, the same
 * way the basic catalog refuses one. Bound values use A2UI's own `{"path": "/x"}` form, so
 * a Table's rows and its selection live in the data model like a TextField's text does.
 */

import { z } from "zod";
import { DynamicStringListSchema, DynamicStringSchema, DynamicValueSchema } from "@a2ui/web_core/v0_9";

/**
 * A table: columns the agent names, rows from the data model (or inline), optional row
 * selection. The selected keys bind to `value` like a ChoicePicker's, so a Button's
 * `context: {"rows": {"path": "/picked"}}` carries them back.
 */
export const TableApi = {
  name: "Table",
  schema: z
    .object({
      weight: z.number().optional(),
      /** Column order and headings; `key` names the field in each row object. */
      columns: z.array(z.object({ key: z.string().min(1), label: z.string(), align: z.enum(["start", "end"]).optional() }).strict()).min(1),
      /** The rows: an array of objects, inline or bound with {"path": "/rows"}. */
      rows: DynamicValueSchema,
      /** Which row field identifies a row; defaults to the first column's key. */
      rowKey: z.string().optional(),
      /** Draw a checkbox per row; the chosen keys go to `value`. */
      selectable: z.boolean().optional(),
      /** The selected row keys, bound: {"path": "/picked"}. */
      value: DynamicStringListSchema.optional(),
      /** Clicking a heading sorts by it. On by default. */
      sortable: z.boolean().optional(),
      /** A line under the table, e.g. what the numbers are. */
      caption: DynamicStringSchema.optional(),
    })
    .strict(),
};

/** Every lumenbox component, in the order they were added. */
export const LUMENBOX_COMPONENTS = [TableApi] as const;
