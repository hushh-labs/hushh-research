// components/kai/cards/kpi-card.tsx

/**
 * KPI Card - Material 3 Expressive card for displaying key metrics
 * 
 * Features:
 * - Glass-morphism effect
 * - Trend indicator with color coding
 * - Icon support
 * - Multiple variants (default, success, warning, danger)
 * - Ripple effect on interaction
 */

"use client";

import { Card, CardContent } from "@/lib/morphy-ux/card";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface KPICardProps {
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

const variantStyles = {
  default: "bg-card border-border",
  success: "bg-emerald-500/10 border-emerald-500/20",
  warning: "bg-amber-500/10 border-amber-500/20",
  danger: "bg-red-500/10 border-red-500/20",
  info: "bg-blue-500/10 border-blue-500/20",
};

const sizeStyles = {
  xs: {
    padding: "p-3",
    title: "text-[10px]",
    value: "text-base",
    change: "text-[10px]",
    icon: "w-8 h-8",
  },
  sm: {
    padding: "p-3.5",
    title: "text-[10px]",
    value: "text-lg",
    change: "text-[10px]",
    icon: "w-10 h-10",
  },
  md: {
    padding: "p-4.5",
    title: "text-[10px]",
    value: "text-xl",
    change: "text-[10px]",
    icon: "w-12 h-12",
  },
  lg: {
    padding: "p-6",
    title: "text-xs",
    value: "text-2xl",
    change: "text-xs",
    icon: "w-14 h-14",
  },
};

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
  const isPositive = change !== undefined && change >= 0;
  const isNeutral = change === 0;
  const styles = sizeStyles[size];

  const TrendIcon = isNeutral ? Minus : isPositive ? TrendingUp : TrendingDown;
  const trendColor = isNeutral
    ? "text-muted-foreground"
    : isPositive
    ? "text-emerald-500"
    : "text-red-500";

  return (
    <Card
      variant="none"
      effect="glass"
      showRipple={!!onClick}
      className={cn(
        "border transition-all duration-200",
        variantStyles[variant],
        onClick && "cursor-pointer hover:scale-[1.02] active:scale-[0.98]",
        className
      )}
      onClick={onClick}
    >
      <CardContent className={styles.padding}>
        {/* Header with icon and title - Icon followed by Title */}
        <div className="flex items-center gap-2.5 mb-2">
          {icon && (
            <div className={cn("text-primary shrink-0", styles.icon)} aria-hidden="true">
              {icon}
            </div>
          )}
          <span className={cn("text-muted-foreground uppercase font-black tracking-widest leading-none", styles.title)}>
            {title}
          </span>
        </div>

        {/* Value */}
        <p
          className={cn("font-black tracking-tighter leading-tight", styles.value)}
          aria-label={`${title}: ${value}`}
        >
          {value}
        </p>

        {/* Optional one-line description */}
        {description && (
          <p className="text-[10px] uppercase font-bold text-muted-foreground/60 mt-1 line-clamp-1 tracking-wider">
            {description}
          </p>
        )}

        {/* Change indicator */}
        {change !== undefined && (
          <div className={cn("flex items-center gap-1 mt-1.5", styles.change, trendColor)}>
            <TrendIcon className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="font-bold">
              {isPositive && !isNeutral ? "+" : ""}
              {change.toFixed(2)}%
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
