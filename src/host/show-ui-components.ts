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
import { ActionSchema, DynamicNumberSchema, DynamicStringListSchema, DynamicStringSchema, DynamicValueSchema } from "@a2ui/web_core/v0_9";

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
      columns: z.array(z.object({
        key: z.string().min(1),
        label: z.string(),
        align: z.enum(["start", "end"]).optional(),
        /** How a cell is drawn: text, a status Badge (tone from the value), a right-aligned number, or a Link. */
        kind: z.enum(["text", "badge", "number", "link"]).optional(),
      }).strict()).min(1),
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

/**
 * A progress card: steps with a status each, or a plain percentage. The agent updates it in
 * place between tool calls with `ShowUI({surface, data})`, which is the point of it.
 */
export const ProgressApi = {
  name: "Progress",
  schema: z
    .object({
      weight: z.number().optional(),
      title: DynamicStringSchema.optional(),
      /** Steps: [{label, status: todo|doing|done|failed|skipped, note?}], inline or bound. */
      steps: DynamicValueSchema.optional(),
      /** 0–100, when there are no steps or alongside them. */
      value: DynamicNumberSchema.optional(),
      /** One line under the bar: what is happening now. */
      label: DynamicStringSchema.optional(),
    })
    .strict(),
};

/** Markdown prose (markdown-it, html off): headings, lists, links, inline code. */
export const MarkdownApi = {
  name: "Markdown",
  schema: z
    .object({
      weight: z.number().optional(),
      text: DynamicStringSchema,
    })
    .strict(),
};

/** A code block with a copy button; `diff` colours +/- lines. */
export const CodeApi = {
  name: "Code",
  schema: z
    .object({
      weight: z.number().optional(),
      text: DynamicStringSchema,
      language: z.string().optional(),
      variant: z.enum(["code", "diff"]).optional(),
      /** A file name or path shown above the block. */
      title: DynamicStringSchema.optional(),
    })
    .strict(),
};

/**
 * Allow / reject, as one component so the pair is always drawn the same way. The host fills
 * `onApprove`/`onReject` with events named `approve`/`reject` when the agent leaves them out,
 * so the usual card carries no actions at all.
 */
export const ApproveApi = {
  name: "Approve",
  schema: z
    .object({
      weight: z.number().optional(),
      title: DynamicStringSchema.optional(),
      detail: DynamicStringSchema.optional(),
      approveLabel: DynamicStringSchema.optional(),
      rejectLabel: DynamicStringSchema.optional(),
      onApprove: ActionSchema.optional(),
      onReject: ActionSchema.optional(),
    })
    .strict(),
};


/**
 * A small chart, drawn as SVG on the page with nothing fetched: bars or a line over
 * `points` of {label, value}, inline or bound.
 */
export const ChartApi = {
  name: "Chart",
  schema: z
    .object({
      weight: z.number().optional(),
      kind: z.enum(["bar", "line"]).optional(),
      title: DynamicStringSchema.optional(),
      /** [{label, value}], inline or bound {"path": "/points"}. */
      points: DynamicValueSchema,
      /** Shown after each value, e.g. "ms" or "%". */
      unit: z.string().optional(),
      /** Pixels; default 160. */
      height: z.number().min(60).max(600).optional(),
    })
    .strict(),
};

/**
 * A file in the box: a link that opens it through the page's own file route, and for text
 * a preview of its first lines. Only paths under the work directory; nothing outside the
 * box is reachable from a card.
 */
export const FilePreviewApi = {
  name: "FilePreview",
  schema: z
    .object({
      weight: z.number().optional(),
      /** An absolute path under /home/box/work. */
      path: z.string().min(1),
      title: DynamicStringSchema.optional(),
      /** How many lines of a text file to show; default 20, 0 for the link only. */
      lines: z.number().int().min(0).max(200).optional(),
    })
    .strict(),
};


/** A short status label. The tone is the colour; the text is the word. */
export const ToneSchema = z.enum(["ok", "warn", "danger", "info", "neutral"]);
export const BadgeApi = {
  name: "Badge",
  schema: z.object({ weight: z.number().optional(), text: DynamicStringSchema, tone: ToneSchema.optional() }).strict(),
};

/** Key: value pairs in two columns; a value may carry a tone. */
export const KeyValueApi = {
  name: "KeyValue",
  schema: z
    .object({
      weight: z.number().optional(),
      /** [{key, value, tone?}], inline or bound. */
      items: DynamicValueSchema,
    })
    .strict(),
};

/** One number that matters, with its label; several in a Row make a strip. */
export const StatApi = {
  name: "Stat",
  schema: z
    .object({
      weight: z.number().optional(),
      label: DynamicStringSchema,
      value: DynamicStringSchema,
      unit: z.string().optional(),
      /** A change to show beside the value, e.g. "+3" or "-12%". */
      delta: DynamicStringSchema.optional(),
      tone: ToneSchema.optional(),
    })
    .strict(),
};

/** A note the person should not miss: a tone, a title, Markdown. */
export const CalloutApi = {
  name: "Callout",
  schema: z
    .object({
      weight: z.number().optional(),
      tone: ToneSchema.optional(),
      title: DynamicStringSchema.optional(),
      text: DynamicStringSchema,
    })
    .strict(),
};

/**
 * A link: to a file in the box (an absolute path under /home/box/work), a task (t12), or an
 * http(s) URL. An external URL shows its host beside the text and never opens by itself.
 */
export const LinkApi = {
  name: "Link",
  schema: z
    .object({
      weight: z.number().optional(),
      text: DynamicStringSchema,
      to: z.string().min(1),
    })
    .strict(),
};

/** Every lumenbox component, in the order they were added. */
export const LUMENBOX_COMPONENTS = [TableApi, ProgressApi, MarkdownApi, CodeApi, ApproveApi, ChartApi, FilePreviewApi, BadgeApi, KeyValueApi, StatApi, CalloutApi, LinkApi] as const;
