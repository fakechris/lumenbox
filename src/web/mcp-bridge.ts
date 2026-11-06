/**
 * `agentbox mcp`: a stdio bridge to a running installation's side door (moved out of cli.ts
 * for INV-1668, unchanged). Stdio because that is the shape every client already knows how to
 * configure — Claude Code, Codex, an editor. It forwards JSON-RPC lines to `/mcp` and writes
 * the replies back — no protocol of its own, so nothing here can disagree with the server
 * about what MCP means. The caller reads the URL and the token from the environment; this
 * module never sees anything else of it, and never prints the token.
 */

export async function runMcpBridge(
  url: string,
  token: string,
  io: { stdin: NodeJS.ReadableStream; write: (text: string) => void; err: (line: string) => void } = { stdin: process.stdin, write: text => process.stdout.write(text), err: line => console.error(line) }
): Promise<number> {
  let buffer = "";
  io.stdin.setEncoding("utf8");
  io.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
      if (line === "") continue;
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: line,
      })
        .then(async response => {
          const text = await response.text();
          // A notification gets an empty object back and has no id; writing that
          // to a client expecting nothing is noise, so it is dropped.
          if (text.trim() !== "" && text.trim() !== "{}") io.write(`${text}\n`);
        })
        .catch((error: unknown) => {
          io.err(`mcp bridge: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
  });
  await new Promise<void>(resolve => io.stdin.on("end", () => resolve()));
  return 0;
}
