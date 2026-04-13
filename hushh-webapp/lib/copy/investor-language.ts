export type InvestorMessageCode =
  | "ACCOUNT_STATE_UNAVAILABLE"
  | "ONBOARDING_STATE_UNAVAILABLE"
  | "VAULT_STATUS_UNAVAILABLE"
  | "LOCAL_BACKEND_UNAVAILABLE"
  | "VAULT_UNLOCK_FAILED"
  | "VAULT_PASSKEY_ENROLL_REQUIRED"
  | "MARKET_DATA_UNAVAILABLE"
  | "ANALYSIS_UNAVAILABLE"
  | "NETWORK_RECOVERY"
  | "SAVE_IN_PROGRESS";

export type InvestorLoadingStage =
  | "SESSION_CHECK"
  | "ACCOUNT_STATE"
  | "ONBOARDING"
  | "MARKET"
  | "ANALYSIS"
  | "VAULT";

export type DecisionDisplayLabel = "BUY" | "HOLD" | "WATCH" | "REDUCE" | "REVIEW";

export interface InvestorDecisionDisplay {
  label: DecisionDisplayLabel;
  tone: "positive" | "neutral" | "negative";
  guidance: string;
}

export const INVESTOR_BANNED_TERMS = [
  "prf",
  "native prf",
  "fallback",
  "runtime",
  "token",
  "wrapper",
  "decrypt",
  "encrypted",
  "debug",
  "stream degraded",
] as const;

export function toInvestorMessage(
  code: InvestorMessageCode,
  context?: { ticker?: string; reason?: string | null }
): string {
  switch (code) {
    case "ACCOUNT_STATE_UNAVAILABLE":
      return "We could not load your account details right now. Please try again.";
    case "ONBOARDING_STATE_UNAVAILABLE":
      return "We could not load your onboarding progress. Please try again.";
    case "VAULT_STATUS_UNAVAILABLE":
      return "We could not check your Vault status right now. Please try again.";
    case "LOCAL_BACKEND_UNAVAILABLE":
      return "Local backend data is unavailable right now. Start the local backend with the proxy-aware launcher, then try again.";
    case "VAULT_UNLOCK_FAILED":
      return "We could not unlock your Vault. Please confirm your details and try again.";
    case "VAULT_PASSKEY_ENROLL_REQUIRED":
      return "This passkey was enrolled under an older domain. Use your passphrase once, then enable passkey again for kai.hushh.ai.";
    case "MARKET_DATA_UNAVAILABLE":
      return "Live market data is temporarily unavailable. Showing the latest available view.";
    case "ANALYSIS_UNAVAILABLE":
      return context?.ticker
        ? `Analysis for ${context.ticker} is not available yet.`
        : "Analysis is not available yet.";
    case "NETWORK_RECOVERY":
      return "Connection was interrupted. We are restoring your session.";
    case "SAVE_IN_PROGRESS":
      return "Your portfolio is being secured. This may take a moment.";
    default:
      return "Please try again.";
  }
}

export function toInvestorVaultUnlockError(value: unknown): string {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "";
  const lowered = raw.toLowerCase();

  if (
    lowered.includes("vault_passkey_rp_mismatch") ||
    lowered.includes("rp id is not allowed") ||
    lowered.includes("different domain")
  ) {
    return toInvestorMessage("VAULT_PASSKEY_ENROLL_REQUIRED");
  }

  if (
    lowered.includes("timed out or was not allowed") ||
    lowered.includes("privacy-considerations-client") ||
    lowered.includes("notallowederror") ||
    lowered.includes("aborterror") ||
    lowered.includes("user cancelled") ||
    lowered.includes("user canceled") ||
    lowered.includes("cancelled") ||
    lowered.includes("canceled")
  ) {
    return "Passkey unlock was cancelled or took too long. Try again, or use your passphrase instead.";
  }

  if (
    lowered.includes("quick unlock is not ready") ||
    lowered.includes("quick unlock is not enabled") ||
    lowered.includes("not enabled on this device")
  ) {
    return "Passkey unlock is not ready on this device yet. Use your passphrase once, then try passkey again.";
  }

  if (
    lowered.includes("recovery key") &&
    lowered.includes("did not match")
  ) {
    return "That recovery key did not match. Please try again.";
  }

  return toInvestorMessage("VAULT_UNLOCK_FAILED");
}

export function toInvestorLoading(stage: InvestorLoadingStage): string {
  switch (stage) {
    case "SESSION_CHECK":
      return "Checking your session...";
    case "ACCOUNT_STATE":
      return "Loading your account...";
    case "ONBOARDING":
      return "Preparing your guided setup...";
    case "MARKET":
      return "Loading market view...";
    case "ANALYSIS":
      return "Preparing your analysis...";
    case "VAULT":
      return "Opening your Vault...";
    default:
      return "Loading...";
  }
}

export function toInvestorDecisionLabel(
  decision: string | null | undefined,
  ownsPosition?: boolean | null
): InvestorDecisionDisplay {
  const normalized = String(decision || "").trim().toLowerCase();
  if (normalized === "buy") {
    return {
      label: "BUY",
      tone: "positive",
      guidance: "Build or add to position based on your plan.",
    };
  }
  if (normalized === "reduce" || normalized === "sell") {
    return {
      label: "REDUCE",
      tone: "negative",
      guidance: "Trim exposure to align with your risk limits.",
    };
  }
  if (normalized === "hold") {
    if (ownsPosition === true) {
      return {
        label: "HOLD",
        tone: "neutral",
        guidance: "Maintain position and monitor key updates.",
      };
    }
    return {
      label: "WATCH",
      tone: "neutral",
      guidance: "Track the name and wait for a clearer entry setup.",
    };
  }
  return {
    label: "REVIEW",
    tone: "neutral",
    guidance: "Review the full analysis before taking action.",
  };
}

const STREAM_TECHNICAL_SUBSTITUTIONS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bva(?:ult)?_?owner token\b/gi, replacement: "secure access" },
  { pattern: /\bconsent token\b/gi, replacement: "secure access" },
  { pattern: /\btoken refresh(?:ed|)\b/gi, replacement: "session refresh" },
  { pattern: /\bdecryption\b/gi, replacement: "unlock" },
  { pattern: /\bdecrypt(?:ed|ing)?\b/gi, replacement: "unlock" },
  { pattern: /\bencryption\b/gi, replacement: "secure storage" },
  { pattern: /\bencrypt(?:ed|ing)?\b/gi, replacement: "secure" },
  { pattern: /\bfallback(?: path)?\b/gi, replacement: "backup source" },
  { pattern: /\bruntime\b/gi, replacement: "session" },
  { pattern: /\bdebug(?:ging|)\b/gi, replacement: "" },
  { pattern: /\btrace(?:s|)\b/gi, replacement: "" },
  { pattern: /\bprovider failure\b/gi, replacement: "data source unavailable" },
  { pattern: /\bhttp\s*\d{3}\b/gi, replacement: "network response" },
  { pattern: /\b429\b/gi, replacement: "temporary capacity limit" },
  { pattern: /\btoo many requests\b/gi, replacement: "capacity limit reached" },
  { pattern: /\bresource exhausted\b/gi, replacement: "service capacity temporarily unavailable" },
  { pattern: /\bportfolio_data_v2\b/gi, replacement: "portfolio details" },
  { pattern: /\braw_extract_v2\b/gi, replacement: "statement details" },
  { pattern: /\banalytics_v2\b/gi, replacement: "analysis details" },
  { pattern: /\bquality_report_v2\b/gi, replacement: "quality check" },
  { pattern: /\bholdings_preview\b/gi, replacement: "confirmed holdings" },
  { pattern: /\bprogress_pct\b/gi, replacement: "progress" },
  { pattern: /\bchunk_count\b/gi, replacement: "update count" },
  { pattern: /\btotal_chars\b/gi, replacement: "response size" },
  { pattern: /\brun_id\b/gi, replacement: "session id" },
  { pattern: /\bcursor\b/gi, replacement: "position" },
  { pattern: /\bseq\b/gi, replacement: "step" },
  { pattern: /\bjson\b/gi, replacement: "details" },
  { pattern: /\bxml\b/gi, replacement: "details" },
  { pattern: /\bpayload\b/gi, replacement: "update" },
  { pattern: /\bendpoint\b/gi, replacement: "service" },
  { pattern: /\bschema\b/gi, replacement: "format" },
  { pattern: /\bapi\b/gi, replacement: "service" },
  { pattern: /\bstream error\b/gi, replacement: "connection interrupted" },
  { pattern: /\bthe network connection was lost\b/gi, replacement: "connection was interrupted while syncing" },
  { pattern: /\bstack trace\b/gi, replacement: "" },
  { pattern: /\btraceback\b/gi, replacement: "" },
  { pattern: /\bexception\b/gi, replacement: "issue" },
  { pattern: /https?:\/\/[^\s)]+/gi, replacement: "" },
];

export function toInvestorStreamText(value: unknown): string {
  const source = typeof value === "string" ? value : "";
  if (!source.trim()) return "";

  let next = source
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  // Remove XML/HTML-ish wrappers that leak from streamed model output.
  next = next.replace(/<\/?[\w:-]+(?:\s[^>]*)?>/g, " ");
  if (/^\s*[\[{]/.test(next) || /"[^"]+"\s*:/.test(next)) {
    return "Reviewing current signals...";
  }
  for (const rule of STREAM_TECHNICAL_SUBSTITUTIONS) {
    next = next.replace(rule.pattern, rule.replacement);
  }
  next = next
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\(\s*\)/g, "")
    .trim();
  if (/connection interrupted while syncing|network response/i.test(next)) {
    return "Connection was interrupted. Reconnecting automatically.";
  }
  if (/did not pass strict validation checks/i.test(next)) {
    return "We could not confirm all holdings from this upload. Please retry or use a clearer brokerage statement.";
  }
  if (/analyzing statement details/i.test(next)) {
    return "Reviewing your statement...";
  }
  return next;
}
