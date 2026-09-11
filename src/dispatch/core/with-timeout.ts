export class TimeoutError extends Error {
  override name = "TimeoutError";

  constructor(ms: number, label?: string) {
    const msg = label ? `Operation "${label}" timed out after ${ms}ms` : `Operation timed out after ${ms}ms`;
    super(msg);
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label?: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(ms, label));
    }, ms);

    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
