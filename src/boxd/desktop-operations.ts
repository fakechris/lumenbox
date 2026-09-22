/** One queue for computer and browser operations per desktop. Revocations never enter it. */
export class DesktopOperations {
  private readonly tails = new Map<number, Promise<void>>();

  async run<T>(display: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(display) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(display, tail);
    await previous;
    try {
      // Authorization belongs inside operation: it must run AFTER the wait.
      return await operation();
    } finally {
      release();
      if (this.tails.get(display) === tail) this.tails.delete(display);
    }
  }
}
