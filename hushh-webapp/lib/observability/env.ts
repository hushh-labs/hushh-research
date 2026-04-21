import { resolveAppEnvironment } from "@/lib/app-env";

export type ObservabilityEnvironment = "uat" | "production";

function normalizeValue(raw: string | undefined | null): string {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function isPlaceholderValue(raw: string | undefined | null): boolean {
  const normalized = normalizeValue(raw);
  if (!normalized) return true;
  return (
    normalized.includes("replace_with") ||
    normalized.includes("pending") ||
    normalized.includes("placeholder") ||
    normalized.includes("dummy")
  );
}

function sanitizeAnalyticsId(
  raw: string | undefined | null,
  pattern: RegExp
): string {
  const value = String(raw || "").trim();
  if (!value || isPlaceholderValue(value) || !pattern.test(value)) {
    return "";
  }
  return value;
}

export function resolveObservabilityEnvironment(): ObservabilityEnvironment {
  return resolveAppEnvironment() === "production" ? "production" : "uat";
}

export function isObservabilityEnabled(): boolean {
  const raw = normalizeValue(process.env.NEXT_PUBLIC_OBSERVABILITY_ENABLED);
  if (!raw) {
    return true;
  }
  return !["0", "false", "no", "off"].includes(raw);
}

export function isObservabilityDebugEnabled(): boolean {
  const raw = normalizeValue(process.env.NEXT_PUBLIC_OBSERVABILITY_DEBUG);
  return ["1", "true", "yes", "on"].includes(raw);
}

export function resolveObservabilitySampleRate(): number {
  const raw = String(process.env.NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE || "").trim();
  if (!raw) {
    return 1;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}

export function resolveAnalyticsMeasurementId(): string {
  return sanitizeAnalyticsId(
    process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
    /^G-[A-Z0-9]+$/i
  );
}

export function resolveGtmContainerId(): string {
  return sanitizeAnalyticsId(
    process.env.NEXT_PUBLIC_GTM_ID,
    /^GTM-[A-Z0-9]+$/i
  );
}
