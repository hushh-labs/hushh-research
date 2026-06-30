export const KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS = 360;

// Keep frontend stream idle guard above backend hard timeout to avoid false aborts.
export const KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS =
  (KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS + 60) * 1000;
