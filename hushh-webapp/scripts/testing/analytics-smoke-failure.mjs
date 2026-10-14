/** A tagged candidate can briefly reject static assets while Cloud Run scales it. */
export function isCandidateStaticAsset5xx({
  candidateOrigin,
  responseUrl,
  status,
}) {
  if (!Number.isInteger(status) || status < 500 || status > 599) return false;
  try {
    const candidate = new URL(candidateOrigin);
    const response = new URL(responseUrl);
    return (
      response.origin === candidate.origin &&
      response.pathname.startsWith("/_next/static/")
    );
  } catch {
    return false;
  }
}

/** Retry only before analytics has initialized, and only after candidate 5xx. */
export function isCandidateAssetUnavailable({
  phase,
  reason,
  failedAssetStatuses,
  observedEventNames,
  observedMeasurementIds,
  observedGaCollectEvents,
}) {
  return (
    phase === "measurement_id" &&
    /^page\.waitForFunction: Timeout \d+ms exceeded\./.test(reason) &&
    failedAssetStatuses.some(
      (status) => Number.isInteger(status) && status >= 500 && status <= 599,
    ) &&
    observedEventNames.length === 0 &&
    observedMeasurementIds.length === 0 &&
    observedGaCollectEvents.length === 0
  );
}
