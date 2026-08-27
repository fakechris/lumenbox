/**
 * What a `.env`-style file *defines*, without its values.
 *
 * "Read my .env and tell me which variables it defines" is a reasonable request with a
 * useless answer today: the whole file goes into the transcript to answer a question
 * about its keys. This answers the question actually asked.
 *
 * **A helper, not a security control, and the distinction is the point.** An earlier
 * design (docs/15, "C2") proposed refusing to serve credential files by path, and the
 * adversarial review killed it: the agent has a shell as its own uid, `bash` reads what
 * the uid can read, and a glob list is a boundary's costume rather than a boundary. The
 * measurement then made it moot from the other side — the box holds no such files, and
 * `~/.config` is a volume *precisely so* logins survive a rebuild. The box is supposed to
 * hold credentials; that is what a workstation does.
 *
 * So what survives is only the useful half: when the question is about shape, answer
 * about shape. Nothing here prevents anything.
 */

/** One line of a `.env`, reduced to what can be said without disclosing anything. */
export interface EnvKey {
  name: string;
  /** So "is it set?" is answerable without the value. */
  empty: boolean;
  /** Roughly how big the value is, which is often what "is this the short one?" means. */
  valueChars: number;
}

export interface EnvShape {
  keys: EnvKey[];
  /** Lines that define nothing: comments, blanks, anything unparseable. */
  otherLines: number;
}

/**
 * Parses a `.env` body.
 *
 * Deliberately here on the host rather than by asking the model to read the file and
 * summarise it — the review's condition for this being worth anything was that the
 * parsing happens outside the model, because a model that reads the file to describe it
 * has already put the file in the context.
 */
export function envShape(body: string): EnvShape {
  const keys: EnvKey[] = [];
  let otherLines = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      otherLines += 1;
      continue;
    }
    // `export FOO=bar` is as common as `FOO=bar` in a file people also source.
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match === null) {
      otherLines += 1;
      continue;
    }
    const name = match[1]!;
    // Quotes are syntax, not value: `FOO=""` is empty and `FOO="x"` is one character.
    const value = match[2]!.trim().replace(/^(['"])(.*)\1$/s, "$2");
    keys.push({ name, empty: value === "", valueChars: value.length });
  }
  return { keys, otherLines };
}

/** The shape as the agent reads it. Never carries a value. */
export function describeEnvShape(path: string, shape: EnvShape): string {
  if (shape.keys.length === 0) {
    return `${path} defines no variables (${shape.otherLines} comment or blank line(s)).`;
  }
  const lines = shape.keys.map(
    key => `  ${key.name}${key.empty ? "  (set to empty)" : `  (${key.valueChars} chars)`}`
  );
  return [
    `${path} defines ${shape.keys.length} variable(s). Values are not shown — this is the ` +
      `shape of the file, not its contents.`,
    ...lines,
    "",
    "If you need a value, do not read it into this conversation: have the command that " +
      "needs it read the file itself, or use RunOnHost with the vault.",
  ].join("\n");
}

/** Whether a path is the kind of file this answers better than a whole-file read. */
export function looksLikeEnvFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return name === ".env" || name.startsWith(".env.");
}
