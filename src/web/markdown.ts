/**
 * Markdown rendering for the chat feed.
 *
 * This started as a hand-written renderer, which was the wrong shape for the problem.
 * Markdown is a large spec with a long tail — tables, nested emphasis, reference
 * links, loose lists — and every gap in a hand-rolled version shows up as an agent's
 * answer rendered wrong. markdown-it covers the spec, and its renderer rules are the
 * hook that things like Mermaid attach to later, which a bespoke parser never offers.
 *
 * The safety property lives in the options rather than in a sanitizer. With
 * html:false, raw HTML in the model's text is escaped instead of parsed, and
 * markdown-it's default link validation rejects javascript: and data: URLs. Nothing
 * untrusted is ever parsed as HTML, so there is no DOMPurify here and nothing to keep
 * in step with it.
 *
 * The browser build is served out of node_modules rather than from a CDN: the UI keeps
 * working with no network, and the version is pinned by package-lock instead of by
 * whatever a CDN answers with.
 */

import { createRequire } from "node:module";

/**
 * The options the page runs with. Exported because they are the security boundary —
 * html:false is what makes model output inert — so they are worth testing rather than
 * trusting to a literal buried in a template.
 */
export const MARKDOWN_OPTIONS = {
  html: false,
  linkify: true,
  // Chat is written the way people type: a single newline is a line break.
  breaks: true,
};

/**
 * The browser bundle. The package's exports map hides the dist paths, so this goes
 * through the "browser" subpath; resolved with require semantics it yields the UMD
 * build, which is the one that defines window.markdownit.
 */
export const VENDOR_MARKDOWN_IT = "markdown-it/browser";

/** Absolute path to a vendored browser build, for the server to read and serve. */
export function vendorPath(spec: string = VENDOR_MARKDOWN_IT): string {
  return createRequire(import.meta.url).resolve(spec);
}
