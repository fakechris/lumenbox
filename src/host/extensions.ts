/**
 * Extensions: the edges you can edit without restarting the core (docs/34, R36).
 *
 * A file under `~/.agentbox/extensions/` — `.mjs`, `.js` or `.ts` — default-exports a function
 * of one argument, the api. With it the file registers **tools** (which arrive in every agent's
 * list as `ext__<name>`, through the same in-process server surface an MCP server's tools use,
 * so allowlists, the lookup pair, the fork fence and the MCP face all apply unchanged) and
 * **listeners** on turn events. Reload tears everything down and imports every file afresh —
 * pi's `/reload`, deepseek-harness's retractable plugin runtime, the shape both proved.
 *
 * What is hot-loaded is the plugin layer, never the core: Node cannot swap the running server's
 * own modules, and a cache-busting import of a file the operator just saved is exactly as much
 * as anyone's reload does. Old module instances stay in memory until the process ends; a file
 * reloaded a thousand times is a thousand small leaks and the operator's choice.
 *
 * Security is the hooks file's rule (docs/10 S-9), because an extension is the same thing —
 * code run with the process's authority from a mutable file in the state directory: a file
 * that is group- or world-writable or owned by another uid is refused, loudly, and skipped.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentboxHome } from "../config.ts";
import { refuseHooksFile } from "./hooks.ts";
import { VirtualServer } from "./mcp.ts";
import type { TurnEvent } from "./turn.ts";

export const EXTENSIONS_SERVER = "ext";

export function extensionsDir(): string {
  return process.env.AGENTBOX_EXTENSIONS ?? join(agentboxHome(), "extensions");
}

/** What a tool an extension registers looks like. Text in, text out, like every tool here. */
export interface ExtensionTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<string> | string;
}

/** The api handed to each extension's default export. */
export interface ExtensionApi {
  /** Registers a tool as `ext__<name>`. A second registration of a name is refused and logged. */
  tool: (definition: ExtensionTool) => void;
  /** Called with every turn event of the given type (`"*"` for all). Errors are logged, never thrown into the turn. */
  on: (type: TurnEvent["type"] | "*", handler: (event: TurnEvent) => void | Promise<void>) => void;
  log: (line: string) => void;
}

export interface ExtensionsLoad {
  /** Files that loaded, by name. */
  loaded: string[];
  /** `ext__…` tool names now registered. */
  tools: string[];
  /** One line per file or registration that was refused, with why. */
  problems: string[];
}

const EXTENSION_FILE = /\.(mjs|js|ts)$/;

export class Extensions {
  private tools: ExtensionTool[] = [];
  private listeners: { type: string; handler: (event: TurnEvent) => void | Promise<void> }[] = [];
  private last: ExtensionsLoad = { loaded: [], tools: [], problems: [] };
  private generation = 0;

  constructor(
    private readonly dir: string = extensionsDir(),
    private readonly log: (line: string) => void = () => {}
  ) {}

  /** What the last load found, for the settings page. */
  current(): ExtensionsLoad {
    return this.last;
  }

  /** The in-process server carrying the registered tools, for `McpManager.setVirtual`. */
  server(): VirtualServer {
    return new VirtualServer(
      EXTENSIONS_SERVER,
      this.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        run: async input => String(await tool.run(input)),
      })),
      `${this.last.loaded.length} extension file(s)`
    );
  }

  /** Tears every registration down and imports every file again. */
  async load(): Promise<ExtensionsLoad> {
    this.generation += 1;
    const generation = this.generation;
    const tools: ExtensionTool[] = [];
    const listeners: typeof this.listeners = [];
    const result: ExtensionsLoad = { loaded: [], tools: [], problems: [] };
    if (!existsSync(this.dir)) {
      this.tools = tools;
      this.listeners = listeners;
      this.last = result;
      return result;
    }
    const names = readdirSync(this.dir).filter(name => EXTENSION_FILE.test(name) && !name.endsWith(".test.ts")).sort();
    for (const name of names) {
      const path = join(this.dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch (error) {
        result.problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!stat.isFile()) continue;
      const refusal = refuseHooksFile(stat);
      if (refusal !== undefined) {
        result.problems.push(`${name}: refused — ${refusal}`);
        this.log(`refusing ${path}: ${refusal}`);
        continue;
      }
      const api: ExtensionApi = {
        tool: definition => {
          const toolName = String(definition?.name ?? "").trim();
          if (!/^[A-Za-z0-9_-]{1,40}$/.test(toolName) || typeof definition.run !== "function") {
            result.problems.push(`${name}: a tool needs a short name and a run function`);
            return;
          }
          if (tools.some(existing => existing.name === toolName)) {
            result.problems.push(`${name}: tool ${toolName} is already registered by an earlier file; refused`);
            return;
          }
          tools.push({ ...definition, name: toolName });
        },
        on: (type, handler) => {
          if (typeof handler === "function") listeners.push({ type, handler });
        },
        log: line => this.log(`${name}: ${line}`),
      };
      try {
        // A fresh URL each time is what makes this a reload: ESM caches by specifier.
        const module = (await import(`${pathToFileURL(path).href}?v=${generation}-${stat.mtimeMs}`)) as { default?: unknown };
        const setup = module.default;
        if (typeof setup !== "function") {
          result.problems.push(`${name}: does not default-export a function`);
          continue;
        }
        await (setup as (api: ExtensionApi) => unknown)(api);
        result.loaded.push(name);
      } catch (error) {
        result.problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        this.log(`${name} failed to load: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Only the newest load's registrations count, even if an older import is still settling.
    if (generation !== this.generation) return this.last;
    this.tools = tools;
    this.listeners = listeners;
    result.tools = tools.map(tool => `${EXTENSIONS_SERVER}__${tool.name}`);
    this.last = result;
    const problems = result.problems.length > 0 ? `; ${result.problems.length} problem(s)` : "";
    this.log(`loaded ${result.loaded.length} file(s), ${tools.length} tool(s), ${listeners.length} listener(s)${problems}`);
    return result;
  }

  /** Fans a turn event out to listeners. A listener that throws is logged and does not stop the turn. */
  emit(event: TurnEvent): void {
    for (const { type, handler } of this.listeners) {
      if (type !== "*" && type !== event.type) continue;
      try {
        const outcome = handler(event);
        if (outcome instanceof Promise) outcome.catch(error => this.log(`listener for ${event.type} failed: ${error instanceof Error ? error.message : String(error)}`));
      } catch (error) {
        this.log(`listener for ${event.type} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
