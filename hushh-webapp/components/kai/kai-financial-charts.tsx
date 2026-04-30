"use client";

import React from "react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { TrendingUp, DollarSign } from "lucide-react";
import { Icon } from "@/lib/morphy-ux/ui";

interface TrendDataPoint {
  year: string;
  value: number;
}

interface KaiFinancialChartsProps {
  quantMetrics: {
    revenue_growth_yoy: number;
    net_income_growth_yoy: number;
    ocf_growth_yoy: number;
    revenue_cagr_3y: number;
    revenue_trend_data: TrendDataPoint[];
    net_income_trend_data: TrendDataPoint[];
    ocf_trend_data: TrendDataPoint[];
    rnd_trend_data: TrendDataPoint[];
  };
  keyMetrics: {
    fundamental: {
      revenue_billions: number;
      fcf_billions: number;
      fcf_margin: number;
      debt_to_equity: number;
      rnd_intensity: number;
      earnings_quality: number;
    };
    valuation?: {
      pe_ratio: number;
      ps_ratio: number;
      enterprise_value_billions: number;
    };
  };
}

// Chart configurations
const revenueTrendConfig = {
  value: { label: "Revenue ($B)", color: "var(--chart-1)" },
} satisfies ChartConfig;

const netIncomeTrendConfig = {
  value: { label: "Net Income ($B)", color: "var(--chart-2)" },
} satisfies ChartConfig;

const cashFlowConfig = {
  ocf: { label: "OCF ($B)", color: "var(--chart-3)" },
  rnd: { label: "R&D ($B)", color: "var(--chart-4)" },
} satisfies ChartConfig;

const radarConfig = {
  value: { label: "Score", color: "var(--chart-1)" },
} satisfies ChartConfig;

export default function KaiFinancialCharts({ quantMetrics, keyMetrics }: KaiFinancialChartsProps) {
  // Prepare Radar Data
  const radarData = [
    { subject: "Revenue Growth", value: (quantMetrics.revenue_growth_yoy || 0) * 100 * 2, fullMark: 100 }, // Scale for visualization
    { subject: "FCF Margin", value: (keyMetrics.fundamental.fcf_margin || 0) * 100 * 2, fullMark: 100 },
    { subject: "R&D Intensity", value: (keyMetrics.fundamental.rnd_intensity || 0) * 100 * 3, fullMark: 100 },
    { subject: "Earn Quality", value: (keyMetrics.fundamental.earnings_quality || 0) * 50, fullMark: 100 }, // Assuming roughly 1-2 range
    { subject: "Debt/Equity", value: Math.max(0, 100 - (keyMetrics.fundamental.debt_to_equity || 0) * 20), fullMark: 100 }, // Lower is better
  ];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 ">
      
      {/* Top Row: Revenue & Net Income */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Revenue Trend */}
        <Card className="border-border/40 bg-card/40 backdrop-blur-sm">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Icon icon={TrendingUp} size="sm" className="text-primary" />
                    Revenue Trend (3Y)
                </CardTitle>
                <CardDescription>
                    CAGR: {(quantMetrics.revenue_cagr_3y * 100).toFixed(1)}%
                </CardDescription>
            </CardHeader>
            <CardContent>
                <ChartContainer config={revenueTrendConfig} className="h-[200px] w-full">
                    <AreaChart data={quantMetrics.revenue_trend_data}>
                        <defs>
                            <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.8} />
                                <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.1} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.4} />
                        <XAxis dataKey="year" tickLine={false} axisLine={false} tickMargin={8} fontSize={10} />
                        <YAxis tickLine={false} axisLine={false} tickFormatter={(value) => `$${value}B`} fontSize={10} />
                        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                        <Area
                            dataKey="value"
                            type="monotone"
                            fill="url(#fillRevenue)"
                            fillOpacity={0.4}
                            stroke="var(--chart-1)"
                        />
                    </AreaChart>
                </ChartContainer>
            </CardContent>
        </Card>

        {/* Net Income Trend */}
        <Card className="border-border/40 bg-card/40 backdrop-blur-sm">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Icon icon={DollarSign} size="sm" className="text-green-500" />
                    Net Income Trend
                </CardTitle>
                <CardDescription>
                    YoY Growth: {(quantMetrics.net_income_growth_yoy * 100).toFixed(1)}%
                </CardDescription>
            </CardHeader>
            <CardContent>
                <ChartContainer config={netIncomeTrendConfig} className="h-[200px] w-full">
                    <BarChart data={quantMetrics.net_income_trend_data}>
                         <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.4} />
                         <XAxis dataKey="year" tickLine={false} axisLine={false} tickMargin={8} fontSize={10} />
                         <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                         <Bar dataKey="value" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                </ChartContainer>
            </CardContent>
        </Card>
      </div>

      {/* Bottom Row: Cash Flow & Radar */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Operating Cash Flow vs R&D */}
          <Card className="border-border/40 bg-card/40 backdrop-blur-sm">
             <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Cash Flow vs R&D</CardTitle>
                  <CardDescription>Capital Allocation Efficiency</CardDescription>
             </CardHeader>
             <CardContent>
                 <ChartContainer config={cashFlowConfig} className="h-[250px] w-full">
                     <ComposedChart data={quantMetrics.ocf_trend_data.map((d, i) => ({
                         year: d.year,
                         ocf: d.value,
                         rnd: quantMetrics.rnd_trend_data[i]?.value || 0
                     }))}>
                        <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.4} />
                        <XAxis dataKey="year" fontSize={10} />
                        <YAxis fontSize={10} />
                        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                        <Legend />
                        <Bar dataKey="ocf" name="OCF" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
                        <Line type="monotone" dataKey="rnd" name="R&D" stroke="var(--chart-4)" strokeWidth={2} />
                     </ComposedChart>
                 </ChartContainer>
             </CardContent>
          </Card>

          {/* Strategic Radar */}
          <Card className="border-border/40 bg-card/40 backdrop-blur-sm">
              <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Strategic Profile</CardTitle>
                  <CardDescription>Multi-dimensional Analysis</CardDescription>
              </CardHeader>
              <CardContent>
                  <ChartContainer config={radarConfig} className="h-[250px] w-full mx-auto">
                      <RadarChart cx="50%" cy="50%" outerRadius="80%" data={radarData}>
                          <PolarGrid strokeOpacity={0.2} />
                          <PolarAngleAxis dataKey="subject" fontSize={10} />
                          <Radar
                              name="Score"
                              dataKey="value"
                              stroke="var(--chart-1)"
                              fill="var(--chart-1)"
                              fillOpacity={0.3}
                          />
                      </RadarChart>
                  </ChartContainer>
              </CardContent>
          </Card>
      </div>
    </div>
  );
}
