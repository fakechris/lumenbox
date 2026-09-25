/**
 * Claude Code's tool names, in ours: the one table.
 *
 * Three places need it — a hub skill's `allowed-tools:` (written against Claude Code), the MCP
 * face checking a delegated engine's permission prompt, and the side-effect tier of an
 * `engine:<name>` call — and it used to live in one of them while a second copy grew in another.
 *
 * A name maps to what it can actually do here and no more: `Grep` is reading and listing, never
 * `bash`, because a skill that asked to search should not be handed a shell.
 */
const ENGINE_TOOLS: Record<string, readonly string[]> = {
  bash: ["bash"],
  read: ["read_file"],
  write: ["write_file"],
  edit: ["edit_file"],
  multiedit: ["edit_file"],
  glob: ["list_dir"],
  ls: ["list_dir"],
  grep: ["read_file", "list_dir"],
  websearch: ["WebSearch"],
  webfetch: ["WebFetch"],
  task: ["Fork"],
  askuserquestion: ["AskUser"],
  todowrite: ["SetTodos"],
};

/** Our tools for one Claude Code tool name, case-insensitively; undefined when it has no counterpart. */
export function engineToolNames(name: string): readonly string[] | undefined {
  return ENGINE_TOOLS[name.toLowerCase()];
}
