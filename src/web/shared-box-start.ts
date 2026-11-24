import { apiError } from "./api-error.ts";

type Connection = { connected: boolean; detail: string };
type Progress = { type: "box_setup"; line: string; done?: boolean; ok?: boolean };

export class SharedBoxStart {
  starting = false;

  constructor(private readonly options: {
    kubernetes: boolean;
    current: () => Connection;
    up: (output: (line: string) => void) => Promise<Connection>;
    broadcast: (event: Progress) => void;
  }) {}

  request() {
    if (this.options.kubernetes) return { status: 409, body: apiError("shared-box-kubernetes") };
    if (this.starting) return { status: 409, body: apiError("box-starting") };
    const current = this.options.current();
    if (current.connected) return { status: 200, body: { ok: true, detail: current.detail } };
    this.starting = true;
    this.options.broadcast({ type: "box_setup", line: "Starting…" });
    void this.run();
    return { status: 202, body: { starting: true } };
  }

  private async run(): Promise<void> {
    let result: Connection;
    try {
      result = await this.options.up(line => this.options.broadcast({ type: "box_setup", line }));
    } catch (error) {
      result = { connected: false, detail: error instanceof Error ? error.message : String(error) };
    }
    this.starting = false;
    this.options.broadcast({ type: "box_setup", line: `${result.connected ? "ready" : "failed"} — ${result.detail}`, done: true, ok: result.connected });
  }
}
