import { asRecord, unwrapToolResult } from "./tool-result-envelope";

export const FINANCE_STOCK_PREVIEW_EXPERIENCE_TYPE = "one.finance_stock_preview.v1" as const;
export const FINANCE_PORTFOLIO_EXPERIENCE_TYPE = "one.finance_portfolio.v1" as const;
export const FINANCE_TOP_GAINERS_EXPERIENCE_TYPE = "one.finance_top_gainers.v1" as const;
export const FINANCE_PORTFOLIO_UPLOAD_EXPERIENCE_TYPE = "one.finance_portfolio_upload.v1" as const;
export const NATIVE_FINANCE_RECEIPT_TYPE = "one.native_finance_receipt.v1" as const;

const NATIVE_FINANCE_RECEIPT_LABELS = {
  holdings: "Holdings view offered",
  allocation: "Allocation view offered",
  performance: "Performance view offered",
  sources: "Portfolio sources offered",
  gainers: "Market gainers view offered",
  losers: "Market losers view offered",
  movers: "Market movers view offered",
  analysis: "Stock analysis offered",
  upload: "Portfolio upload offered",
  plaid: "Link account offered",
  switch: "Portfolio switch offered",
  delete: "Statement removal offered",
  connection: "Portfolio sharing offered",
  verified_advisor: "Advisor sharing offered",
  received: "Received Finance offered",
} as const;

type NativeFinanceReceipt = {
  type: typeof NATIVE_FINANCE_RECEIPT_TYPE;
  label: (typeof NATIVE_FINANCE_RECEIPT_LABELS)[keyof typeof NATIVE_FINANCE_RECEIPT_LABELS];
};

type FinanceTopGainersExperience = {
  type: typeof FINANCE_TOP_GAINERS_EXPERIENCE_TYPE;
  historical?: true;
};

export type FinancePortfolioSection = "holdings" | "allocation" | "performance" | "sources";
type FinancePortfolioExperience = { type: typeof FINANCE_PORTFOLIO_EXPERIENCE_TYPE; section: FinancePortfolioSection };

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
  | NativeFinanceReceipt
  | FinanceTopGainersExperience;

export function parseNativeFinanceReceipt(content: unknown): NativeFinanceReceipt | null {
  const record = asRecord(content);
  const offer = record?.offer;
  if (record?.type !== NATIVE_FINANCE_RECEIPT_TYPE || typeof offer !== "string" ||
      !Object.hasOwn(NATIVE_FINANCE_RECEIPT_LABELS, offer)) return null;
  return {
    type: NATIVE_FINANCE_RECEIPT_TYPE,
    label: NATIVE_FINANCE_RECEIPT_LABELS[offer as keyof typeof NATIVE_FINANCE_RECEIPT_LABELS],
  };
}

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
      (section !== "holdings" && section !== "allocation" && section !== "performance" && section !== "sources")) return null;
  return { type: FINANCE_PORTFOLIO_EXPERIENCE_TYPE, section };
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
