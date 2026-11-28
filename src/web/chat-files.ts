/**
 * A chat's files on a box (INV-2261): the inbox a dropped file lands in, the outbox an agent leaves
 * a deliverable in, and a file a reply names by its path. Each is on the box of the agent the
 * message is for — the box its turn reads and writes (`chatFilesRoot`, prompt.ts) — and on the
 * installation's own box only when no agent is named or it has gone. Before, all of it was the
 * installation's own box, so a member's own agent in their personal box never saw a file sent to
 * it and never had one it made sent back.
 */

import type { AgentRegistry } from "../agents/registry.ts";
import { conversationIdFor } from "../agents/registry.ts";
import type { BoxEntry } from "../box/boxes.ts";
import type { BoxClient } from "../box/client.ts";
import { chatFilesRoot } from "../host/prompt.ts";

export type ChatBox = { client: BoxClient | undefined; box: BoxEntry };

/** The box an agent's chat files are on, and the client that reaches it. */
export function chatBoxFor(deps: { registry: Pick<AgentRegistry, "tryGet" | "boxOf" | "defaultBox">; boxClient: (agentId?: string) => BoxClient | undefined }): (agent: string | undefined) => ChatBox {
  return agent => {
    const found = agent === undefined ? undefined : deps.registry.tryGet(agent);
    return found === undefined ? { client: deps.boxClient(), box: deps.registry.defaultBox() } : { client: deps.boxClient(found.id), box: deps.registry.boxOf(found.id) };
  };
}

/** The chat door's file dependencies (ChannelManager `receiveFiles`, `workDir`, `readBoxFile`, `collectOutbox`, `outboxDelivered`). */
export function chatFiles(deps: { boxOf: (agent: string | undefined) => ChatBox; workRoot: (box: BoxEntry) => string; log: (line: string) => void }) {
  const { boxOf } = deps;
  return {
    // A file dropped in the chat lands in that chat's inbox on the box, under a name
    // that never overwrites: a second report.pdf becomes report-2.pdf, because the
    // first one may be exactly what the agent is reading.
    receiveFiles: async (chatKey: string, files: { name: string; base64: string }[], agent?: string): Promise<string[] | undefined> => {
      const { client, box } = boxOf(agent); // the box of the agent the message is for, where its turn reads its inbox (INV-2261)
      if (client === undefined) return undefined;
      const dir = `${chatFilesRoot(conversationIdFor(chatKey), box)}/inbox`;
      await client.exec(`mkdir -p '${dir}'`, { actor: "host:chat-inbox" });
      let existing: Set<string>;
      try {
        existing = new Set((await client.listDir(dir)).entries.map(entry => entry.name));
      } catch {
        existing = new Set();
      }
      const saved: string[] = [];
      for (const file of files) {
        const clean = file.name.replace(/[/\\\0]/g, "_").slice(0, 120) || "file";
        let name = clean;
        for (let n = 2; existing.has(name); n++) {
          const dot = clean.lastIndexOf(".");
          name = dot > 0 ? `${clean.slice(0, dot)}-${n}${clean.slice(dot)}` : `${clean}-${n}`;
        }
        existing.add(name);
        await client.uploadFile(`${dir}/${name}`, file.base64);
        saved.push(`inbox/${name}`);
      }
      return saved;
    },
    // The chat's outbox on the box: list, download, and — once pushed — move to
    // sent/, so nothing is delivered twice and nothing undelivered is lost. A chat
    // that never used files has no directory, and that is the cheap ordinary case.
    // For a reply that named a deliverable instead of sending it. Confined to the work
    // directory by the box's own upload/download guard, and refused above 25MB the same
    // way the outbox is.
    workDir: (agent?: string) => deps.workRoot(boxOf(agent).box), // the box readBoxFile reads, whose paths a reply names (INV-1737)
    readBoxFile: async (path: string, agent?: string): Promise<{ name: string; base64: string } | undefined> => {
      const { client } = boxOf(agent);
      if (client === undefined) return undefined;
      try {
        const file = await client.downloadFile(path);
        const name = path.split("/").pop() ?? "file";
        return { name, base64: file.base64 };
      } catch {
        return undefined;
      }
    },
    collectOutbox: async (chatKey: string, agent?: string): Promise<{ name: string; base64: string }[]> => {
      const { client, box } = boxOf(agent);
      if (client === undefined) return [];
      const dir = `${chatFilesRoot(conversationIdFor(chatKey), box)}/outbox`;
      let entries: { name: string; type: string; size: number }[];
      try {
        entries = (await client.listDir(dir)).entries;
      } catch {
        return [];
      }
      const files: { name: string; base64: string }[] = [];
      for (const entry of entries) {
        if (entry.type !== "file") continue;
        if (entry.size > 25 * 1024 * 1024) {
          deps.log(`outbox: ${entry.name} skipped (${entry.size} bytes is past the 25MB cap)`);
          continue;
        }
        try {
          files.push({ name: entry.name, base64: (await client.downloadFile(`${dir}/${entry.name}`)).base64 });
        } catch (error) {
          deps.log(`outbox: could not read ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Smallest first: if a push dies midway, the cheap ones made it out.
      return files.sort((a, b) => a.base64.length - b.base64.length);
    },
    outboxDelivered: async (chatKey: string, names: string[], agent?: string): Promise<void> => {
      const { client, box } = boxOf(agent);
      if (client === undefined) return;
      const dir = `${chatFilesRoot(conversationIdFor(chatKey), box)}/outbox`;
      const quoted = names.map(name => `'${name.replace(/'/g, `'\\''`)}'`).join(" ");
      await client.exec(`mkdir -p '${dir}/../sent' && cd '${dir}' && mv -- ${quoted} ../sent/`, {
        actor: "host:outbox-delivered",
      });
    },
  };
}
