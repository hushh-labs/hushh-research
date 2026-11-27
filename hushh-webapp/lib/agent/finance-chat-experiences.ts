import { asRecord, unwrapToolResult } from "./tool-result-envelope";

export const FINANCE_STOCK_PREVIEW_EXPERIENCE_TYPE = "one.finance_stock_preview.v1" as const;
export const FINANCE_PORTFOLIO_EXPERIENCE_TYPE = "one.finance_portfolio.v1" as const;
export const FINANCE_TOP_GAINERS_EXPERIENCE_TYPE = "one.finance_top_gainers.v1" as const;
export const FINANCE_PORTFOLIO_UPLOAD_EXPERIENCE_TYPE = "one.finance_portfolio_upload.v1" as const;
export const PORTFOLIO_SWITCH_CONTRACT = 1;

type FinanceTopGainersExperience = {
  type: typeof FINANCE_TOP_GAINERS_EXPERIENCE_TYPE;
  historical?: true;
};

export type FinancePortfolioSection = "holdings" | "allocation" | "performance" | "sources";
type FinancePortfolioExperience = {
  type: typeof FINANCE_PORTFOLIO_EXPERIENCE_TYPE;
  section: FinancePortfolioSection | "switch";
  historical?: true;
};

type FinanceStockPreviewExperience = {
  type: typeof FINANCE_STOCK_PREVIEW_EXPERIENCE_TYPE;
  ticker: string;
};

type FinancePortfolioUploadExperience = {
  type: typeof FINANCE_PORTFOLIO_UPLOAD_EXPERIENCE_TYPE;
  offerId: string;
  historical?: true;
};

export type FinanceCardExperience =
  | FinancePortfolioExperience
  | FinanceStockPreviewExperience
  | FinancePortfolioUploadExperience
  | FinanceTopGainersExperience;

export function parseFinancePortfolioUpload(content: unknown): FinancePortfolioUploadExperience | null {
  const record = asRecord(content);
  if (record?.type !== FINANCE_PORTFOLIO_UPLOAD_EXPERIENCE_TYPE ||
      typeof record.offerId !== "string" || !/^[a-f0-9]{32}$/.test(record.offerId)) return null;
  return {
    type: FINANCE_PORTFOLIO_UPLOAD_EXPERIENCE_TYPE,
    offerId: record.offerId,
    ...(record.historical === true && { historical: true }),
  };
}

export function parseFinanceTopGainers(content: unknown): FinanceTopGainersExperience | null {
  const record = asRecord(content);
  if (record?.type !== FINANCE_TOP_GAINERS_EXPERIENCE_TYPE) return null;
  return { type: FINANCE_TOP_GAINERS_EXPERIENCE_TYPE, ...(record.historical === true && { historical: true }) };
}

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
      (section !== "holdings" && section !== "allocation" && section !== "performance" &&
        section !== "sources" && section !== "switch")) return null;
  return {
    type: FINANCE_PORTFOLIO_EXPERIENCE_TYPE, section,
    ...(section === "switch" && record.historical === true && { historical: true }),
  };
}

export function parseFinanceToolResult(toolName: string | null | undefined, content: unknown): FinanceCardExperience | null {
  if (toolName === "show_portfolio_upload") {
    const result = unwrapToolResult(content);
    return result?.status === "card_offered" ? parseFinancePortfolioUpload(result.structured) : null;
  }
  if (toolName === "show_stock_preview") {
    const result = unwrapToolResult(content);
    return result?.status === "preview_offered" ? parseFinanceStockPreview(result.structured) : null;
  }
  if (toolName === "show_market_gainers") {
    const result = unwrapToolResult(content);
    return result?.status === "card_offered" ? parseFinanceTopGainers(result.structured) : null;
  }
  if (toolName === "show_portfolio_card") {
    const result = unwrapToolResult(content);
    return result?.status === "card_offered" ? parseFinancePortfolio(result.structured) : null;
  }
  return null;
}
