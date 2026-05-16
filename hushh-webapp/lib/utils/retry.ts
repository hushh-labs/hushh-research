export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  delay?: (delayMs: number) => Promise<void>;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function retryAsync<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    retries = 3,
    delayMs = 300,
    shouldRetry = () => true,
    delay = wait,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt < retries && shouldRetry(error, attempt)) {
        await delay(delayMs);
      } else {
        break;
      }
    }
  }

  throw lastError;
}
