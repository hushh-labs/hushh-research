import type { PortfolioData } from "@/components/kai/types/portfolio";
import type { PortfolioData as ReviewPortfolioData } from "./portfolio-review-view";

/** Keep observed statement balances and periods through the post-save projection. */
export function projectSavedPortfolio(savedData: ReviewPortfolioData, holdings: PortfolioData["holdings"]): PortfolioData {
  return {
    account_info: savedData.account_info
      ? {
          account_number: savedData.account_info.account_number,
          brokerage_name: savedData.account_info.brokerage,
          account_holder: savedData.account_info.holder_name,
          statement_period_start: savedData.account_info.statement_period_start,
          statement_period_end: savedData.account_info.statement_period_end,
        }
      : undefined,
    account_summary: savedData.account_summary
      ? {
          beginning_value: savedData.account_summary.beginning_value,
          ending_value:
            savedData.account_summary.ending_value ??
            savedData.total_value ??
            0,
          change_in_value: savedData.account_summary.change_in_value,
          cash_balance: savedData.account_summary.cash_balance,
          equities_value: savedData.account_summary.equities_value,
        }
      : undefined,
    holdings,
    historical_values: savedData.historical_values,
    source_metadata: savedData.source_metadata,
    transactions: [],
    asset_allocation: savedData.asset_allocation
      ? {
          cash_percent: savedData.asset_allocation.cash_pct,
          equities_percent: savedData.asset_allocation.equities_pct,
          bonds_percent: savedData.asset_allocation.bonds_pct,
        }
      : undefined,
    income_summary: savedData.income_summary
      ? {
          dividends: savedData.income_summary.dividends_taxable,
          interest: savedData.income_summary.interest_income,
          total: savedData.income_summary.total_income,
        }
      : undefined,
    realized_gain_loss: savedData.realized_gain_loss
      ? {
          short_term: savedData.realized_gain_loss.short_term_gain,
          long_term: savedData.realized_gain_loss.long_term_gain,
          total: savedData.realized_gain_loss.net_realized,
        }
      : undefined,
    parse_fallback: savedData.parse_fallback,
  };
}
