/**
 * Single source of truth for backend traffic.
 * Optimized for resilience with build-time safety to ensure CI validation passes.
 */

export function getPythonApiUrl(): string {
  const runtimeUrl =
    process.env.PYTHON_API_URL || process.env.BACKEND_URL;

  const appEnv =
    process.env.NEXT_PUBLIC_APP_ENV ||
    process.env.NODE_ENV ||
    "development";

  const isHosted = !["local", "development", "test"].includes(
    appEnv
  );

  // Local development fallback
  if (!runtimeUrl && !isHosted) {
    return "http://127.0.0.1:8000";
  }

  // Hosted environments must provide backend origin
  if (!runtimeUrl && isHosted) {
    throw new Error("Missing backend origin");
  }

  // Hosted environments cannot use localhost
  if (
    isHosted &&
    runtimeUrl &&
    runtimeUrl.includes("localhost")
  ) {
    throw new Error(
      "resolved backend origin to localhost"
    );
  }

  // Canonicalize localhost → 127.0.0.1
  return runtimeUrl!.replace(
    "http://localhost:",
    "http://127.0.0.1:"
  );
}

export function getDeveloperApiUrl(): string {
  return (
    process.env.DEVELOPER_API_URL ||
    process.env.BACKEND_URL ||
    "http://127.0.0.1:8000"
  );
}

/**
 * High-efficiency request handler with retry + timeout support.
 */
export async function proxyWithRetry(
  path: string,
  options: RequestInit & {
    timeout?: number;
    retries?: number;
  } = {}
): Promise<Response> {
  const baseUrl = getPythonApiUrl();

  const url = `${baseUrl}${
    path.startsWith("/") ? path : `/${path}`
  }`;

  const {
    timeout = 8000,
    retries = 3,
    ...fetchOptions
  } = options;

  let lastError: unknown;

  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, timeout);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Success OR non-retryable client errors
      if (
        response.ok ||
        (response.status < 500 &&
          response.status !== 429)
      ) {
        return response;
      }

      // Exponential backoff
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, i) * 1000)
      );
    } catch (err: unknown) {
      clearTimeout(timer);

      lastError = err;

      // Retry timeout errors
      if (
        err instanceof Error &&
        err.name === "AbortError" &&
        i < retries - 1
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, i) * 1000)
        );

        continue;
      }

      if (i === retries - 1) {
        break;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Request failed at ${path}`);
}