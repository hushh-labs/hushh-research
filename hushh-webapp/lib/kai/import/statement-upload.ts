import type { PortfolioData } from "@/components/kai/views/portfolio-review-view";
import { normalizePortfolioData } from "./normalize-statement";

export const STATEMENT_FILE_ACCEPT = ".pdf,.csv,application/pdf,text/csv";
export const MAX_STATEMENT_FILE_SIZE_MESSAGE = "File too large. Maximum size is 25MB.";
const STATEMENT_MIME_TYPES = new Set(["application/pdf", "text/csv", "application/vnd.ms-excel"]);

export function statementFileError(file: File): string | null {
  if (file.size > 25 * 1024 * 1024) return MAX_STATEMENT_FILE_SIZE_MESSAGE;
  if (!STATEMENT_MIME_TYPES.has(file.type) && !/\.(csv|pdf)$/i.test(file.name)) {
    return "Invalid file type. Please upload a PDF or CSV file.";
  }
  return null;
}

export function statementImportForm(file: File, userId: string): FormData {
  const form = new FormData();
  form.append("file", file);
  form.append("user_id", userId);
  return form;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

export function readStatementImportResult(payload: Record<string, unknown>): PortfolioData {
  const portfolio = record(payload.portfolio_data_v2);
  if (!portfolio) throw new Error("Missing portfolio_data_v2 in complete event");
  return normalizePortfolioData({
    ...portfolio,
    raw_extract_v2: record(payload.raw_extract_v2),
    analytics_v2: record(payload.analytics_v2),
    quality_report_v2: record(payload.quality_report_v2),
    parse_fallback: readBoolean(payload.parse_fallback) ?? readBoolean(portfolio.parse_fallback) ?? false,
  });
}
