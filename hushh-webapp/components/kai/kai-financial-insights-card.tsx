"use client";

interface Insight {
  label: string;
  value: string;
  trend: string;
}

interface FinancialInsightsCardProps {
  insights?: Insight[];
}

export default function FinancialInsightsCard({
  insights = [
    { label: "Liquidity Health", value: "Strong", trend: "+12%" },
    { label: "Idle Capital", value: "$8,400", trend: "-5%" },
    { label: "Growth Opportunity", value: "Moderate", trend: "+18%" },
  ],
}: FinancialInsightsCardProps) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
      <div className="mb-4">
        <h2 className="text-xl font-semibold text-white">
          AI Financial Insights
        </h2>
        <p className="text-sm text-zinc-400">
          Snapshot of portfolio intelligence and recommendations
        </p>
      </div>

      <div className="space-y-4">
        {insights.map((item, index) => (
          <div
            key={index}
            className="flex items-center justify-between rounded-xl bg-zinc-800 p-4"
          >
            <div>
              <p className="text-sm text-zinc-400">{item.label}</p>
              <p className="text-lg font-semibold text-white">{item.value}</p>
            </div>
            <span className="text-sm font-medium text-green-400">
              {item.trend}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}