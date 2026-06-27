"use client";

import * as React from "react";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

// =============================================================================
// TYPES & CONFIGURATION
// =============================================================================

export interface KPICardProps {
  title: string;
  value: string;
  description?: string;
  change?: number;
  changeLabel?: string;
  icon?: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "info";
  size?: "xs" | "sm" | "md" | "lg";
  onClick?: () => void;
  className?: string;
}

const variantStyles: Record<NonNullable<KPICardProps['variant']>, string> = {
  default: "bg-card border-border",
  success: "bg-emerald-500/10 border-emerald-500/20",
  warning: "bg-amber-500/10 border-amber-500/20",
  danger: "bg-red-500/10 border-red-500/20",
  info: "bg-blue-500/10 border-blue-500/20",
};

const sizeClasses: Record<NonNullable<KPICardProps['size']>, string> = {
  xs: "p-3 text-base",
  sm: "p-3.5 text-lg",
  md: "p-4.5 text-xl",
  lg: "p-6 text-2xl",
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

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
}: KPICardProps) {

  const { icon: TrendIcon, color: trendColor, sign } = React.useMemo(() => {
    if (change === undefined) return { icon: null, color: "", sign: "" };
    if (change > 0) return { icon: TrendingUp, color: "text-emerald-500", sign: "+" };
    if (change < 0) return { icon: TrendingDown, color: "text-red-500", sign: "" };
    return { icon: Minus, color: "text-muted-foreground", sign: "" };
  }, [change]);

  return (
    <Card
      variant="none"
      effect="glass"
      showRipple={!!onClick}
      className={cn(
        "border transition-all duration-200 overflow-hidden",
        variantStyles[variant],
        onClick && "cursor-pointer hover:scale-[1.02] active:scale-[0.98]",
        className
      )}
      onClick={onClick}
    >
      <CardContent className={sizeClasses[size]}>
        <div className="flex items-center gap-2.5 mb-2">
          {icon && <div className="text-primary shrink-0 scale-90">{icon}</div>}
          <span className="text-[10px] text-muted-foreground uppercase font-semibold tracking-widest leading-none">
            {title}
          </span>
        </div>

        <p className="font-semibold tracking-tighter leading-tight" aria-live="polite">
          {value}
        </p>

        {description && (
          <p className="text-[10px] uppercase font-bold text-muted-foreground/60 mt-1 truncate tracking-wider">
            {description}
          </p>
        )}

        {TrendIcon && change !== undefined && (
          <div className={cn("flex items-center gap-1 mt-1.5 text-[10px]", trendColor)}>
            <TrendIcon className="w-3.5 h-3.5" />
            <span className="font-bold">
              {sign}{change.toFixed(2)}%
            </span>
            {changeLabel && (
              <span className="text-muted-foreground font-medium ml-0.5">({changeLabel})</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default KPICard;