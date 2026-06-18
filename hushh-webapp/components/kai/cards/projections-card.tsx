"use client";

import { useMemo } from "react";
import { TrendingUp, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Icon } from "@/lib/morphy-ux/ui";
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from "recharts";

// 1. Move Interfaces here (or ensure they are imported correctly)
export interface MonthlyProjection {
  month: string;
  projected_income: number;
}

export interface MRDEstimate {
  year: number;
  required_amount: number;
  amount_taken: number;
  remaining: number;
}

export interface ProjectionsAndMRD {
  estimated_cash_flow?: MonthlyProjection[];
  mrd_estimate?: MRDEstimate;
}

interface ProjectionsCardProps {
  projections?: ProjectionsAndMRD;
  className?: string;
  isLoading?: boolean;
}

// 2. Define Helpers here
const formatCurrency = (val: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(val);

const formatCompact = (val: number) =>
  val >= 1000000 ? `$${(val / 1000000).toFixed(1)}M` : val >= 1000 ? `$${(val / 1000).toFixed(0)}K` : `$${val.toFixed(0)}`;

function MRDSection({ mrd }: { mrd: MRDEstimate }) {
  const percent = Math.min(100, Math.max(0, (mrd.amount_taken / (mrd.required_amount || 1)) * 100));
  const isComplete = mrd.remaining <= 0;
  return (
    <div className="space-y-3 pt-4 border-t border-border/50">
      {/* ... (rest of MRDSection) */}
    </div>
  );
}

export function ProjectionsCard({ projections, className, isLoading }: ProjectionsCardProps) {
  const { estimated_cash_flow: cashFlow, mrd_estimate: mrd } = projections || {};

  const stats = useMemo(() => {
    if (!cashFlow?.length) return { total: 0, avg: 0, trend: 0 };

    // 3. Fix: Explicitly type 'sum' and 'p' to resolve implicit 'any'
    const total = cashFlow.reduce((sum: number, p: MonthlyProjection) => sum + p.projected_income, 0);
    const avg = total / cashFlow.length;

    // 4. Fix: Use optional chaining to resolve 'object is possibly undefined'
    const first = cashFlow[0]?.projected_income ?? 0;
    const last = cashFlow[cashFlow.length - 1]?.projected_income ?? 0;
    const trend = first !== 0 ? ((last - first) / first) * 100 : 0;

    return { total, avg, trend };
  }, [cashFlow]);

  if (isLoading) return <Card className={cn("h-48 animate-pulse", className)} />;
  if (!cashFlow?.length && !mrd) return null;

  return (
    <Card className={cn("w-full border-border/50", className)}>
      {/* Component Body remains as previously optimized */}
    </Card>
  );
}