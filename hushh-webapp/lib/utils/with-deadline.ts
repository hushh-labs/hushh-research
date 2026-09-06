/** Bound an asynchronous read, including bridges that cannot be aborted.
 * A late settlement is observed but cannot resume the timed-out caller.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => {
        reject(
          Object.assign(new Error("Request timed out."), {
            name: "TimeoutError",
          }),
        );
      },
      Math.max(0, deadlineMs - Date.now()),
    );
    promise.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
