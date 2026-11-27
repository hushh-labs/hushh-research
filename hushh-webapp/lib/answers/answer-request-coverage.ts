import type { AnswerRequestCoverage } from "@/lib/services/answer-request-service";

// Coverage labels disclose the priced selectors, never owner memory values.
export function validAnswerCoverage(value: AnswerRequestCoverage | undefined): value is AnswerRequestCoverage {
  if (!value || !Array.isArray(value.included) || !Array.isArray(value.notIncluded) ||
      !value.included.length || value.included.length + value.notIncluded.length > 12) return false;
  const rows = [...value.included, ...value.notIncluded];
  if (rows.some(entry => !entry || typeof entry.scope !== "string" ||
      !/^attr\.[a-z0-9_]+(?:\.[a-z0-9_*]+)+$/.test(entry.scope) ||
      !(entry.label === null || typeof entry.label === "string" && entry.label.length <= 160))) return false;
  return new Set(rows.map(entry => entry.scope)).size === rows.length;
}

export function coverageLabel(label: string | null): string {
  const clean = label?.replace(/\s+/g, " ").trim();
  return clean && !/[\u0000-\u001f\u007f]/.test(clean) ? clean.slice(0, 120) : "Requested information";
}
