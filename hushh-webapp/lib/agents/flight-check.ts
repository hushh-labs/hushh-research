export type FlightCheckStatus =
  | "ready"
  | "warming"
  | "degraded"
  | "unauthorized"
  | "unavailable";

export type FlightCheckName = "auth" | "cache" | "service";

export type FlightCheckResult = {
  status: FlightCheckStatus;
  checks: Record<FlightCheckName, boolean>;
  checkedAt: number;
};

export type FlightCheckOptions = {
  authReady?: boolean;
  cacheReady?: boolean;
  serviceReady?: boolean;
};

export function runAgentToolFlightCheck({
  authReady = true,
  cacheReady = true,
  serviceReady = true,
}: FlightCheckOptions = {}): FlightCheckResult {
  const checks = {
    auth: authReady,
    cache: cacheReady,
    service: serviceReady,
  };

  let status: FlightCheckStatus = "ready";

  if (!authReady) {
    status = "unauthorized";
  } else if (!serviceReady) {
    status = "unavailable";
  } else if (!cacheReady) {
    status = "warming";
  }

  return {
    status,
    checks,
    checkedAt: Date.now(),
  };
}

export function isAgentToolFlightCheckReady(result: FlightCheckResult) {
  return result.status === "ready";
}