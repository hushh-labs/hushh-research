"use client";

import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "@/lib/utils";

// Format: { THEME_NAME: CSS_SELECTOR }
const THEMES = { light: "", dark: ".dark" } as const;

export type ChartConfig = {
  [k: string]: {
    label?: React.ReactNode;
    icon?: React.ComponentType;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  );
};

// --- Container ---
export function ChartContainer({
  id,
  className,
  config,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ReactNode; // Changed to ReactNode to satisfy ResponsiveContainer
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`;

  return (
    <div
      data-chart={chartId}
      className={cn(
        "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground",
        className
      )}
      {...props}
    >
      <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">
        {children as React.ReactElement}
      </RechartsPrimitive.ResponsiveContainer>
    </div>
  );
}

// --- Tooltip Content ---
// We define a specific interface to bypass "Property does not exist" errors
interface TooltipContentProps extends React.HTMLAttributes<HTMLDivElement> {
  active?: boolean;
  payload?: any[];
  indicator?: "line" | "dot" | "dashed";
  hideLabel?: boolean;
  label?: string;
  labelFormatter?: (label: string, payload: any[]) => React.ReactNode;
  formatter?: (value: any, name: string, item: any, index: number, payload: any) => React.ReactNode;
}

export function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  label,
  labelFormatter,
  formatter,
}: TooltipContentProps) {
  if (!active || !payload?.length) return null;

  return (
    <div className={cn("bg-background border px-2.5 py-1.5 text-xs shadow-xl rounded-lg", className)}>
      {!hideLabel && label && (
        <div className="font-medium mb-1.5">
          {labelFormatter ? labelFormatter(label, payload) : label}
        </div>
      )}
      <div className="grid gap-1.5">
        {payload.map((item, index) => (
          <div key={index} className="flex items-center gap-2">
            <div
              className={cn("h-2 w-2 rounded-[2px]", indicator === "line" && "w-1 h-3")}
              style={{ backgroundColor: item.color || item.payload?.fill }}
            />
            <span className="text-muted-foreground">{item.name}:</span>
            <span className="font-mono font-medium">
              {formatter ? formatter(item.value, item.name, item, index, item.payload) : item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export { RechartsPrimitive as Chart };