/**
 * The watchdog's only road in (INV-1509, docs/91): the side door, as any outside MCP client uses it.
 *
 * Hand-rolled JSON-RPC over HTTP like the server half. A transport failure — refused, timed out,
 * a status that is not 200 — is `DoorUnreachable`, which is what the watchdog counts toward
 * "the orchestrator is gone". A tool's own refusal is a reply with `isError`, which is not.
 */

export class DoorUnreachable extends Error {}
/** The door answered and refused this token (401/403): not an outage, and retrying will not change it (INV-1520). */
export class DoorRefused extends Error {}

export interface DoorReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

export interface Door {
  call(name: string, args: Record<string, unknown>, options?: { idempotencyKey?: string; timeoutMs?: number }): Promise<DoorReply>;
  /** The side door's stated capabilities (`initialize`), so a watchdog can tell a door too old for it (INV-1517). */
  capabilities?(): Promise<Record<string, boolean>>;
}

export function doorClient(url: string, token: string, fetchImpl: typeof fetch = fetch): Door {
  const endpoint = `${url.replace(/\/+$/, "")}/mcp`;
  let id = 0;
  return {
    async capabilities() {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "initialize", params: {} }), signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        throw new DoorUnreachable(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status !== 200) throw new DoorUnreachable(`${endpoint}: HTTP ${response.status}`);
      const body = (await response.json()) as { result?: { capabilities?: { experimental?: { lumenbox?: Record<string, boolean> } } } };
      return body.result?.capabilities?.experimental?.lumenbox ?? {};
    },
    async call(name, args, options = {}) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(options.idempotencyKey !== undefined ? { "idempotency-key": options.idempotencyKey } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
        });
      } catch (error) {
        throw new DoorUnreachable(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status === 401 || response.status === 403) throw new DoorRefused(`${endpoint}: HTTP ${response.status}`);
      if (response.status !== 200) throw new DoorUnreachable(`${endpoint}: HTTP ${response.status}`);
      const body = (await response.json()) as { result?: { content?: { text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }; error?: { message?: string } };
      if (body.error !== undefined) return { text: body.error.message ?? "error", isError: true };
      const text = body.result?.content?.map(part => part.text ?? "").join("\n") ?? "";
      return { text, isError: body.result?.isError === true, ...(body.result?.structuredContent !== undefined ? { structured: body.result.structuredContent } : {}) };
    },
  };
}
