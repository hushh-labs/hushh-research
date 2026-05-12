const activeRequests = new Map<string, Promise<unknown>>();

export async function deduplicateRequest<T>(
  key: string,
  runner: () => Promise<T>
): Promise<T> {
  const existingRequest = activeRequests.get(key);

  if (existingRequest) {
    return existingRequest as Promise<T>;
  }

  const nextRequest = runner().finally(() => {
    activeRequests.delete(key);
  });

  activeRequests.set(key, nextRequest);

  return nextRequest;
}

export function clearDeduplicatedRequest(key: string) {
  activeRequests.delete(key);
}

export function clearAllDeduplicatedRequests() {
  activeRequests.clear();
}

export function getActiveDeduplicatedRequestCount() {
  return activeRequests.size;
}