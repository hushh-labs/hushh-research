import { asRecord, unwrapToolResult } from "./tool-result-envelope";

export const FINANCE_STOCK_PREVIEW_EXPERIENCE_TYPE = "one.finance_stock_preview.v1" as const;
export const FINANCE_PORTFOLIO_EXPERIENCE_TYPE = "one.finance_portfolio.v1" as const;
export type FinancePortfolioSection = "holdings" | "allocation" | "performance" | "sources";
type FinancePortfolioExperience = { type: typeof FINANCE_PORTFOLIO_EXPERIENCE_TYPE; section: FinancePortfolioSection };

type FinanceStockPreviewExperience = {
  type: typeof FINANCE_STOCK_PREVIEW_EXPERIENCE_TYPE;
  ticker: string;
};

export type FinanceCardExperience = FinancePortfolioExperience | FinanceStockPreviewExperience;

export function parseFinanceStockPreview(content: unknown): FinanceStockPreviewExperience | null {
  const record = asRecord(content);
  if (record?.type !== FINANCE_STOCK_PREVIEW_EXPERIENCE_TYPE) return null;
  const { ticker } = record;
  if (typeof ticker !== "string" || !/^[A-Z0-9^][A-Z0-9.\-^=]{0,15}$/.test(ticker)) return null;
  return { type: FINANCE_STOCK_PREVIEW_EXPERIENCE_TYPE, ticker };
}

export function parseFinancePortfolio(content: unknown): FinancePortfolioExperience | null {
  const record = asRecord(content);
  const section = record?.section;
  if (record?.type !== FINANCE_PORTFOLIO_EXPERIENCE_TYPE ||
      (section !== "holdings" && section !== "allocation" && section !== "performance" && section !== "sources")) return null;
  return { type: FINANCE_PORTFOLIO_EXPERIENCE_TYPE, section };
}

export function parseFinanceToolResult(toolName: string | null | undefined, content: unknown): FinanceCardExperience | null {
  if (toolName === "show_stock_preview") {
    const result = unwrapToolResult(content);
    return result?.status === "preview_offered" ? parseFinanceStockPreview(result.structured) : null;
  }
  if (toolName === "show_portfolio_card") {
    const result = unwrapToolResult(content);
    return result?.status === "card_offered" ? parseFinancePortfolio(result.structured) : null;
  }
  return null;
}
