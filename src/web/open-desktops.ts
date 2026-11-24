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
  private readonly open = new Map<Socket, () => boolean>();

  hold(socket: Socket, mayStay: () => boolean): void {
    this.open.set(socket, mayStay);
    socket.once("close", () => this.open.delete(socket));
  }

  /** Closes every socket whose holder may no longer have it; returns how many. */
  recheck(): number {
    let closed = 0;
    for (const [socket, mayStay] of this.open) {
      let stays = false;
      try { stays = mayStay(); } catch { /* a question that cannot be answered is a no */ }
      if (stays) continue;
      this.open.delete(socket);
      socket.destroy();
      closed++;
    }
    return closed;
  }
}
