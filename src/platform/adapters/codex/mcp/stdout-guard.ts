/**
 * Protocol stdout guard — keeps non-protocol bytes off the MCP stdio transport.
 *
 * On a stdio MCP transport fd 1 IS a protocol channel: every byte written to
 * stdout must be a newline-framed JSON-RPC message, and a client that reads
 * anything else sees a corrupted stream. A third-party library that logs to
 * stdout — crawlee's default @apify/log INFO logger does exactly that during
 * web_search/web_read — would interleave its log lines with the responses, so
 * the process must divert stdout before serving and hand the server a private
 * handle on the writer that was stdout.
 *
 * installProtocolStdoutGuard() captures the current `process.stdout.write`
 * (bound) as that protocol writer, then replaces `process.stdout.write` with a
 * forwarder to `process.stderr.write`: everything that logs to stdout
 * afterwards — console.log included — lands on stderr, where diagnostics
 * belong, and can no longer corrupt the protocol stream.
 *
 * The returned handle also owns the error surface of the captured writer: an
 * asynchronous failure such as EPIPE is forwarded through
 * `stream.on("error", ...)`, so the server reports it and stops writing
 * instead of crashing the process.
 *
 * @module
 */

/** Handle returned by {@link installProtocolStdoutGuard}. */
export interface ProtocolStdoutGuard {
  /**
   * The captured protocol writer. The MCP server only ever writes with
   * `.write(string)` and subscribes to asynchronous writer failures with
   * `.on("error", ...)`, so exposing exactly those members (cast to
   * NodeJS.WritableStream at this boundary) is deliberate.
   */
  stream: NodeJS.WritableStream;
  /** Put the writer that was in place at install time back on process.stdout. */
  restore(): void;
}

let installed: ProtocolStdoutGuard | undefined;

/** One `error` listener registered through {@link ProtocolStdoutGuard.stream}. */
type ProtocolErrorListener = (err: unknown) => void;

/**
 * Divert process.stdout to process.stderr and return the writer the MCP server
 * must use for protocol messages. The writer also forwards asynchronous
 * failures of the captured stdout (an EPIPE once the pipe reader is gone) to
 * listeners registered with `.on("error", ...)`, which is how the server
 * learns to stop writing instead of dying on an unhandled event. Installing
 * twice returns the same handle without re-patching;
 * {@link ProtocolStdoutGuard.restore} undoes it (used by tests — the stdio
 * entry never restores, it serves until stdin closes).
 */
export function installProtocolStdoutGuard(): ProtocolStdoutGuard {
  if (installed) return installed;

  const originalWrite = process.stdout.write;
  const protocolWrite = originalWrite.bind(process.stdout);

  // The listener lives on the real stdout from install time, not only while a
  // consumer is attached: an EPIPE can arrive during boot, before the server
  // exists, and a write-only stream left that window unhandled.
  const errorListeners = new Set<ProtocolErrorListener>();
  const forwardError = (err: unknown): void => {
    for (const listener of errorListeners) {
      try {
        listener(err);
      } catch {
        // A diagnostics listener must never throw back into the emitter.
      }
    }
  };
  const captured = process.stdout as unknown as {
    on?: (event: string, listener: ProtocolErrorListener) => unknown;
    removeListener?: (event: string, listener: ProtocolErrorListener) => unknown;
  };
  if (typeof captured.on === "function") captured.on("error", forwardError);

  const stream = {
    write: protocolWrite,
    on(event: string, listener: ProtocolErrorListener): unknown {
      if (event === "error") errorListeners.add(listener);
      return stream;
    },
  } as unknown as NodeJS.WritableStream;

  const forwardToStderr = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    try {
      return (
        process.stderr.write as (c: unknown, e?: unknown, cb?: unknown) => boolean
      )(chunk, encoding, callback);
    } catch {
      // Best effort: a closed stderr must never throw into the logging caller.
      return true;
    }
  };
  process.stdout.write = forwardToStderr as typeof process.stdout.write;

  installed = {
    stream,
    restore(): void {
      process.stdout.write = originalWrite;
      errorListeners.clear();
      if (typeof captured.removeListener === "function") {
        captured.removeListener("error", forwardError);
      }
      installed = undefined;
    },
  };
  return installed;
}
