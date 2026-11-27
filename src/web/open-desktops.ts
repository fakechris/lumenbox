/**
 * Desktop sockets that are still open, each with the question that let it in (INV-2071).
 *
 * Admission is checked on the upgrade, once. The RFB socket then lives for as long as the
 * tab does, so removing a person or signing them out everywhere stopped their next request
 * but left the screen they already had streaming, and drivable. Whatever changes who may do
 * what asks every open socket its question again; a socket whose answer is now no is closed.
 */

import type { Socket } from "node:net";

export class OpenDesktops {
  private readonly open = new Map<Socket, { mayStay: () => boolean; revoked?: () => void }>();

  /** `revoked` is told just before a socket is closed for its holder, so the record can say why it ended. */
  hold(socket: Socket, mayStay: () => boolean, revoked?: () => void): void {
    this.open.set(socket, { mayStay, ...(revoked !== undefined ? { revoked } : {}) });
    socket.once("close", () => this.open.delete(socket));
  }

  /** Closes every socket whose holder may no longer have it; returns how many. */
  recheck(): number {
    let closed = 0;
    for (const [socket, held] of this.open) {
      let stays = false;
      try { stays = held.mayStay(); } catch { /* a question that cannot be answered is a no */ }
      if (stays) continue;
      this.open.delete(socket);
      try { held.revoked?.(); } catch { /* the record is not a reason to keep the socket */ }
      socket.destroy();
      closed++;
    }
    return closed;
  }
}
