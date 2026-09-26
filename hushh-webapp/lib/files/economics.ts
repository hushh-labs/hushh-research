/** Illustrative US regional rates, reviewed 2026-09-25. Not an invoice or quota. */
export function estimatePodSubtotal(storedBytes: number, activeHours: number) {
  if (
    !Number.isFinite(storedBytes) ||
    storedBytes < 0 ||
    !Number.isFinite(activeHours) ||
    activeHours < 0
  ) {
    throw new Error("Usage must be a nonnegative finite number.");
  }
  const storage = (storedBytes / 1024 ** 3) * 0.02;
  const compute = activeHours * 3600 * (0.000024 + 0.0000025);
  return { storage, compute, key: 0.06, subtotal: storage + compute + 0.06 };
}
