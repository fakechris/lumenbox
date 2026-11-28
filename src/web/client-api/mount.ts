/**
 * The client API wired to the server's own parts, so `server.ts` mounts it in two lines (docs/106 §4).
 * Everything the frame and the handlers read comes through `ClientApiDeps`; this is the one place
 * that names the server's objects.
 */

import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Principals } from "../../host/principals.ts";
import { IdempotencyStore } from "../idempotency.ts";
import type { McpTokenStore } from "../mcp-tokens.ts";
import type { Attempt, SignInDoor, SignInGuard } from "../sign-in-limits.ts";
import { clientApi } from "./frame.ts";

export const CLIENT_API_IDEMPOTENCY = "client-api-idempotency.jsonl";

export function mountClientApi(server: {
  tokens: McpTokenStore;
  principals: Principals;
  homeOf(personId: string): { id: string } | undefined;
  version: string;
  /** The limiter as it is now: it is replaced when the exposure level is read, after this is built. */
  signIns(): SignInGuard;
  attemptFrom(req: IncomingMessage, door: SignInDoor): Attempt;
  home: string;
  log(line: string): void;
}) {
  const attempt = (req: IncomingMessage) => server.attemptFrom(req, "client-api");
  return clientApi({
    tokens: server.tokens,
    person: id => {
      server.principals.reload(); // the roster as it is now: a person removed a moment ago is removed here too
      const person = server.principals.byId(id);
      return person === undefined ? undefined : { id: person.id, name: person.name, role: person.role };
    },
    installationMode: () => server.principals.installation().mode,
    version: server.version,
    homeAgentOf: id => server.homeOf(id)?.id,
    signIns: { blocked: req => server.signIns().blocked(attempt(req)), failed: (req, reason) => server.signIns().failed(attempt(req), reason) },
    address: req => attempt(req).address,
    idempotency: new IdempotencyStore({ ttlMs: 24 * 60 * 60_000, persistTo: join(server.home, CLIENT_API_IDEMPOTENCY) }),
    log: server.log,
  });
}
