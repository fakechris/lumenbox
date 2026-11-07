/**
 * Prints the first-run page (INV-1696) for the shell, which shows it before anything else is
 * started and does not load TypeScript itself: `first-run-page.ts <languages>`, where languages
 * is the system's preferred list (`zh-CN,en-US`).
 */
import { firstRunPage } from "./machine-use-ui.ts";

process.stdout.write(firstRunPage(process.argv[2]));
