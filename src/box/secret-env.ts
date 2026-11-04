/**
 * Secrets reach `docker` through its environment, never its argv (INV-1560).
 *
 * `docker run --env BOXD_TOKEN=<value>` puts the value on the command line, where `ps` shows it to
 * every user of the machine, and where a failed run's "Command failed: docker run …" carried it into
 * the update's progress (GET /api/box/image) and server.log (2026-11-04). `--env NAME` with no value
 * makes the CLI read NAME from its own environment instead, so the value never becomes text.
 */

const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL/i;

/** The argv with each secret `--env NAME=value` reduced to `--env NAME`, and those values as environment. */
export function secretsOutOfArgs(args: readonly string[]): { args: string[]; env: Record<string, string> } {
  const out: string[] = [];
  const env: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    if ((arg === "--env" || arg === "-e") && next !== undefined) {
      const at = next.indexOf("=");
      const name = at > 0 ? next.slice(0, at) : "";
      if (at > 0 && SECRET_NAME.test(name)) {
        env[name] = next.slice(at + 1);
        out.push(arg, name);
        i++;
        continue;
      }
    }
    out.push(arg);
  }
  return { args: out, env };
}

/** Any secret-named NAME=value left in a text (an error, a log line) with its value hidden. */
export function redactSecretAssignments(text: string): string {
  return text.replace(/\b([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g, (whole, name: string) => (SECRET_NAME.test(name) ? `${name}=***` : whole));
}
