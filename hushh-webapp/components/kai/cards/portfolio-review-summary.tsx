import { formatCurrency } from "@/lib/kai/market-value-format";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { formatImportNumber } from "@/lib/kai/import/extraction-progress";

interface PortfolioReviewSummaryProps {
  totalValue: number;
  unrealizedGainLoss: number;
  holdingCount: number;
  riskBucket: string;
  cashBalance: number;
  loading?: boolean;
  gainLossAvailable?: boolean;
  preview?: { totalValue?: number | null; cashBalance?: number | null; positionsFound?: number; currency?: string | null };
}

export function PortfolioReviewSummary({
  totalValue,
  unrealizedGainLoss,
  holdingCount,
  riskBucket,
  cashBalance,
  loading = false,
  gainLossAvailable = true,
  preview,
}: PortfolioReviewSummaryProps) {
  const facts = [
    { label: "Portfolio value", value: formatCurrency(totalValue), partial: formatImportNumber(preview?.totalValue, preview?.currency) },
    { label: loading && preview ? "Positions found" : "Positions", value: holdingCount.toLocaleString(), partial: preview?.positionsFound?.toLocaleString() },
    { label: "Cash", value: formatCurrency(cashBalance), partial: formatImportNumber(preview?.cashBalance, preview?.currency) },
    { label: "Portfolio risk", value: riskBucket, className: "capitalize" },
  ];
  return (
    <Card variant="none" preset="surface">
      <CardContent className="p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {facts.map(({ label, value, className, partial }) => (
            <div key={label} className="min-w-0 space-y-0.5">
              <dt className="ui-text-row-description text-muted-foreground">{label}</dt>
              <dd className={"min-h-5 ui-text-row-label-emphasized break-words tabular-nums " + (className ?? "")}>
                {loading && partial == null ? <span aria-hidden="true" className="my-1 block h-3.5 w-16 rounded bg-muted motion-safe:animate-pulse" /> : <span className="motion-step-enter">{loading ? partial : value}</span>}
              </dd>
            </div>
          ))}
        </dl>
        {
          <p className="ui-text-row-description mt-3 border-t border-border pt-2 text-muted-foreground">
            {loading ? <span aria-hidden="true" className="block h-4 w-40 rounded bg-muted motion-safe:animate-pulse" /> : <span className="motion-step-enter">{gainLossAvailable ? `${formatCurrency(unrealizedGainLoss)} unrealized gain / loss` : "Unrealized gain / loss not supplied"}</span>}
          </p>
        }
      </CardContent>
    </Card>
  );
}
