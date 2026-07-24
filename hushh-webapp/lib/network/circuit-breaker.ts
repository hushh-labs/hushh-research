type CircuitBreakerState = "closed" | "open" | "half-open";

type CircuitBreakerOptions = {
  failureThreshold?: number;
  cooldownMs?: number;
};

type CircuitBreakerSnapshot = {
  state: CircuitBreakerState;
  failures: number;
  nextRetryAt: number | null;
};

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

const circuitBreakers = new Map<string, CircuitBreakerSnapshot>();

function createInitialSnapshot(): CircuitBreakerSnapshot {
  return {
    state: "closed",
    failures: 0,
    nextRetryAt: null,
  };
}

export function getCircuitBreakerSnapshot(key: string): CircuitBreakerSnapshot {
  return circuitBreakers.get(key) ?? createInitialSnapshot();
}

export function canRunCircuitBreakerRequest(key: string) {
  const snapshot = getCircuitBreakerSnapshot(key);

  if (snapshot.state !== "open") {
    return true;
  }

  return Boolean(snapshot.nextRetryAt && Date.now() >= snapshot.nextRetryAt);
}

export function recordCircuitBreakerSuccess(key: string) {
  circuitBreakers.set(key, createInitialSnapshot());
}

export function recordCircuitBreakerFailure(
  key: string,
  {
    failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    cooldownMs = DEFAULT_COOLDOWN_MS,
  }: CircuitBreakerOptions = {}
) {
  const snapshot = getCircuitBreakerSnapshot(key);
  const failures = snapshot.failures + 1;

  circuitBreakers.set(key, {
    state: failures >= failureThreshold ? "open" : "closed",
    failures,
    nextRetryAt: failures >= failureThreshold ? Date.now() + cooldownMs : null,
  });
}

export async function runWithCircuitBreaker<T>(
  key: string,
  runner: () => Promise<T>,
  options: CircuitBreakerOptions = {}
): Promise<T> {
  const snapshot = getCircuitBreakerSnapshot(key);

  if (!canRunCircuitBreakerRequest(key)) {
    throw new Error(`Circuit breaker is open for ${key}`);
  }

  if (snapshot.state === "open") {
    circuitBreakers.set(key, {
      ...snapshot,
      state: "half-open",
    });
  }

  try {
    const result = await runner();
    recordCircuitBreakerSuccess(key);
    return result;
  } catch (error) {
    recordCircuitBreakerFailure(key, options);
    throw error;
  }
}

export function resetCircuitBreaker(key: string) {
  circuitBreakers.delete(key);
}

export function resetAllCircuitBreakers() {
  circuitBreakers.clear();
}