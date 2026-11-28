/**
 * Files dropped in a chat with no words follow the agent that reads them (INV-2303).
 *
 * A drop is stored at once, in the box of the agent the conversation reaches, and waits for the
 * next message — which may name another agent, on another box, whose turn reads its own. The drop
 * keeps its bytes for its window, so it can be stored again there, through the same dependency as
 * any chat file (never into a box the sender may not enter); a file that cannot be is left out of
 * the turn rather than named at a path its box does not have.
 */

/** What a turn is told it was handed with a message: the words, then where each file is. The chat's and a phone's message alike (INV-2214). */
export function handedFilesNote(text: string, paths: readonly string[]): string {
  return paths.length > 0 ? `${text}\n\n[随这条消息收到的文件: ${paths.join(", ")}]` : text;
}

/** A file dropped with no words: where it was stored, for which agent, and its bytes. */
export type Drop = { path: string; agent: string | undefined; file: { name: string; base64: string } };

export interface DropDeps {
  /** The box an agent's chat files are on. Without it every agent is taken to share one. */
  filesBox?: (agent?: string) => string | undefined;
  receiveFiles?: (chatKey: string, files: { name: string; base64: string }[], agent?: string, identity?: string) => Promise<string[] | undefined>;
  log: (line: string) => void;
}

/** The paths this turn's agent finds the drops at, in its own box. */
export async function dropsFor(drops: readonly Drop[], agent: string | undefined, chat: { key: string; identity: string }, deps: DropDeps): Promise<string[]> {
  const box = deps.filesBox;
  if (box === undefined || drops.every(drop => box(drop.agent) === box(agent))) return drops.map(drop => drop.path);
  const here = drops.filter(drop => box(drop.agent) === box(agent)), moving = drops.filter(drop => box(drop.agent) !== box(agent));
  let moved: string[] | undefined;
  try {
    moved = await deps.receiveFiles?.(chat.key, moving.map(drop => drop.file), agent, chat.identity);
  } catch (error) {
    deps.log(`channel: dropped files could not follow the request to ${agent ?? "the default agent"} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (moved === undefined) deps.log(`channel: ${moving.length} dropped file(s) left out of ${agent ?? "the default agent"}'s turn: not in its box`);
  return [...here.map(drop => drop.path), ...(moved ?? [])];
}
