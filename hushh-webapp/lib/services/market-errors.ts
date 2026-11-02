/** Shared market failure identity; import-safe for transport and browser fixtures. */
export class MarketInsightsEmptyError extends Error {
  readonly status = 404;

  constructor() {
    super("Market insights are not ready yet.");
    this.name = "MarketInsightsEmptyError";
  }
}

export class MarketNewsSnapshotChangedError extends Error {
  readonly status = 409;

  constructor() {
    super("Market news refreshed. Start again to see the latest headlines.");
    this.name = "MarketNewsSnapshotChangedError";
  }
}

export function isMarketInsightsEmptyError(
  error: unknown,
): error is MarketInsightsEmptyError {
  return error instanceof MarketInsightsEmptyError;
}

