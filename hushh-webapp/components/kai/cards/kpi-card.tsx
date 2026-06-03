"use client";

import { useMemo } from "react";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus, Loader2 } from "lucide-react";

// --- GLOBAL STYLES (Scope: Top Level) ---
const variantStyles = {
  default: "bg-card border-border",
  success: "bg-emerald-500/10 border-emerald-500/20",
  warning: "bg-amber-500/10 border-amber-500/20",
  danger: "bg-red-500/10 border-red-500/20",
  info: "bg-blue-500/10 border-blue-500/20",
};

const sizeStyles = {
  xs: { padding: "p-3", title: "text-[10px]", value: "text-base", change: "text-[10px]", icon: "w-8 h-8" },
  sm: { padding: "p-3.5", title: "text-[10px]", value: "text-lg", change: "text-[10px]", icon: "w-10 h-10" },
  md: { padding: "p-4.5", title: "text-[10px]", value: "text-xl", change: "text-[10px]", icon: "w-12 h-12" },
  lg: { padding: "p-6", title: "text-xs", value: "text-2xl", change: "text-xs", icon: "w-14 h-14" },
};

interface KPICardProps {
  title: string;
  value: string | number;
  description?: string;
  change?: number;
  changeLabel?: string;
  icon?: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "info";
  size?: "xs" | "sm" | "md" | "lg";
  onClick?: () => void;
  className?: string;
  isLoading?: boolean;
  valueFormatter?: (val: string | number) => string;
}

export function KPICard({
  title,
  value,
  description,
  change,
  changeLabel,
  icon,
  variant = "default",
  size = "md",
  onClick,
  className,
  isLoading = false,
  valueFormatter = (val) => String(val),
}: KPICardProps) {
  
  const styles = sizeStyles[size];

  const trend = useMemo(() => {
    if (change === undefined) return null;
    return {
      isPositive: change > 0,
      isNeutral: change === 0,
      color: change === 0 ? "text-muted-foreground" : change > 0 ? "text-emerald-500" : "text-red-500",
      Icon: change === 0 ? Minus : change > 0 ? TrendingUp : TrendingDown
    };
  }, [change]);

  return (
    <Card
      variant="none"
      effect="glass"
      showRipple={!!onClick}
      className={cn(
        "border transition-all duration-300 ease-out",
        variantStyles[variant],
        onClick && "cursor-pointer hover:shadow-lg hover:scale-[1.01] active:scale-[0.98]",
        className
      )}
      onClick={onClick}
      role="region"
      aria-label={`KPI Metric: ${title}`}
    >
      <CardContent className={styles.padding}>
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 mb-2">
              {icon && <div className={cn("text-primary shrink-0", styles.icon)}>{icon}</div>}
              <h3 className={cn("text-muted-foreground uppercase font-black tracking-widest", styles.title)}>
                {title}
              </h3>
            </div>

            <p 
              className={cn("font-black tracking-tighter leading-tight", styles.value)}
              aria-live="polite"
            >
              {valueFormatter(value)}
            </p>

            {description && (
              <p className="text-[10px] uppercase font-bold text-muted-foreground/60 mt-1 line-clamp-1">
                {description}
              </p>
            )}

            {trend && (
              <div className={cn("flex items-center gap-1 mt-1.5", styles.change, trend.color)}>
                <trend.Icon className="w-3.5 h-3.5" />
                <span className="font-bold">
                  {trend.isPositive ? "+" : ""}{change?.toFixed(2)}%
                </span>
                {changeLabel && <span className="text-muted-foreground ml-0.5">({changeLabel})</span>}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default KPICard;