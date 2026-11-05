import { formatCurrency } from "@/lib/kai/market-value-format";
import { Card, CardContent } from "@/lib/morphy-ux/card";

interface PortfolioReviewSummaryProps {
  totalValue: number;
  unrealizedGainLoss: number;
  holdingCount: number;
  riskBucket: string;
  cashBalance: number;
}

export function PortfolioReviewSummary({
  totalValue,
  unrealizedGainLoss,
  holdingCount,
  riskBucket,
  cashBalance,
}: PortfolioReviewSummaryProps) {
  const facts = [
    { label: "Portfolio value", value: formatCurrency(totalValue) },
    { label: "Positions", value: holdingCount.toLocaleString() },
    { label: "Cash", value: formatCurrency(cashBalance) },
    { label: "Portfolio risk", value: riskBucket, className: "capitalize" },
  ];
  return (
    <Card variant="none" preset="surface">
      <CardContent className="p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {facts.map(({ label, value, className }) => (
            <div key={label} className="min-w-0 space-y-0.5">
              <dt className="ui-text-row-description text-muted-foreground">{label}</dt>
              <dd className={"ui-text-row-label-emphasized break-words tabular-nums " + (className ?? "")}>{value}</dd>
            </div>
          ))}
        </dl>
        {unrealizedGainLoss !== 0 ? (
          <p className="ui-text-row-description mt-3 border-t border-border pt-2 text-muted-foreground">
            {formatCurrency(unrealizedGainLoss)} unrealized gain / loss
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
