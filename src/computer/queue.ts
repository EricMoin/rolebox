/** Serializes observations and gestures within one host process. */
export class ComputerOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let started = false;
      let cancelled = signal.aborted;
      const onAbort = () => {
        cancelled = true;
        if (!started) reject(new Error("Computer operation cancelled before it started."));
      };
      if (cancelled) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.tail = this.tail.then(async () => {
        try {
          if (cancelled) return;
          started = true;
          resolve(await operation());
        } catch (error) {
          reject(error);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      });
    });
  }
}

export const computerOperationQueue = new ComputerOperationQueue();
