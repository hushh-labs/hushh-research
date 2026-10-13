"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { type IconWeight } from "@phosphor-icons/react";

import {
  Card as StockCard,
  CardContent as StockCardContent,
  CardDescription as StockCardDescription,
  CardFooter as StockCardFooter,
  CardHeader as StockCardHeader,
  CardTitle as StockCardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { type MorphyCardBaseProps } from "@/lib/morphy-ux/types";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

export type CardType = "apple" | "legacy";

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    MorphyCardBaseProps {
  asChild?: boolean;
  type?: CardType;
  icon?: {
    icon: React.ComponentType<{ className?: string; weight?: IconWeight }>;
    title?: string;
    position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    gradient?: boolean;
  };
}

type IconPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

const CARD_PRESET_SHELL_CLASSES: Record<
  NonNullable<CardProps["preset"]>,
  { shell: string; spacing: string }
> = {
  compact: {
    shell:
      "!rounded-[var(--app-card-radius-compact)] !border-transparent !bg-[color:var(--app-card-surface-compact)] !shadow-[var(--app-card-shadow-standard)]",
    spacing: "p-0",
  },
  default: {
    shell:
      "!rounded-[var(--app-card-radius-standard)] !border-transparent !bg-[color:var(--app-card-surface-default-solid)] !shadow-[var(--app-card-shadow-standard)]",
    spacing: "p-4 sm:p-6",
  },
  hero: {
    shell:
      "!rounded-[var(--app-card-radius-feature)] !border-transparent !bg-[color:var(--app-card-surface-hero)] !shadow-[var(--app-card-shadow-feature)]",
    spacing: "p-0",
  },
  surface: {
    shell:
      "!rounded-[var(--app-card-radius-feature)] !border-transparent !bg-[color:var(--app-card-surface-surface)] !shadow-[var(--app-card-shadow-standard)]",
    spacing: "min-w-0 p-0",
  },
  "surface-feature": {
    shell:
      "!rounded-[var(--app-card-radius-feature)] !border-transparent !bg-[color:var(--app-card-surface-hero)] !shadow-[var(--app-card-shadow-feature)]",
    spacing: "min-w-0 p-0",
  },
};

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  (
    {
      className,
      variant = "none",
      effect = "glass",
      preset = "default",
      type,
      asChild = false,
      showRipple = false,
      icon,
      interactive,
      selected,
      fullHeight,
      glassAccent = "none",
      children,
      ...props
    },
    ref
  ) => {
    const isApple = type === "apple";
    const Comp = asChild ? Slot : StockCard;
    const presetConfig = CARD_PRESET_SHELL_CLASSES[preset];

    const IconComponent = icon?.icon;
    const iconPosition = icon?.position || "top-left";

    const iconAlignClasses: Record<IconPosition, string> = {
      "top-left": "justify-start mb-4",
      "top-right": "justify-end mb-4 flex-row-reverse",
      "bottom-left": "justify-start mt-4",
      "bottom-right": "justify-end mt-4 flex-row-reverse",
    };

    const getIconBoxStyle = (isGradient: boolean) => {
      if (isGradient) {
        return "bg-gradient-to-r from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)] border-transparent";
      }
      return "bg-transparent border-transparent";
    };

    const getIconColor = (isGradient: boolean) => {
      if (isGradient) {
        return "text-white dark:text-black";
      }
      return "text-muted-foreground";
    };

    const renderIconBlock = () => {
      if (!IconComponent) return null;

      const gradient = Boolean(icon?.gradient);
      return (
        <div className={cn("flex items-center gap-3 w-full", iconAlignClasses[iconPosition])}>
          <div
            className={cn(
              "h-10 w-10 rounded-lg border flex items-center justify-center transition-colors duration-200",
              getIconBoxStyle(gradient)
            )}
          >
            <IconComponent
              className={cn("h-5 w-5 transition-colors duration-200", getIconColor(gradient))}
              weight="regular"
            />
          </div>
          {icon?.title ? (
            <span className="text-sm font-semibold group-hover:underline group-hover:underline-offset-4">
              {icon.title}
            </span>
          ) : null}
        </div>
      );
    };

    return (
        <Comp
        ref={ref}
        className={cn(
          "relative !overflow-visible transition-[box-shadow,background-color] duration-200",
          isApple
            ? "!rounded-[var(--app-card-radius-standard)] !border-0 !bg-[color:var(--app-card-surface-default-solid)] !shadow-[var(--app-card-shadow-standard)]"
            : cn("border border-solid border-transparent", presetConfig.shell),
          "!text-card-foreground",
          isApple
            ? ""
            : effect === "fade"
              ? "!backdrop-blur-none"
              : "backdrop-blur-[22px] backdrop-saturate-[155%] backdrop-contrast-[1.02]",
          isApple ? "min-w-0 p-0" : presetConfig.spacing,
          interactive ? "cursor-pointer" : "",
          fullHeight ? "h-full" : "",
          selected ? "ring-1 ring-foreground/10 dark:ring-white/10" : "",
          className
        )}
        {...props}
      >
        {!isApple && effect === "glass" ? (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0",
              glassAccent === "none" &&
                "bg-[linear-gradient(180deg,rgba(255,255,255,0.22)_0%,rgba(255,255,255,0.12)_16%,rgba(255,255,255,0.04)_32%,transparent_48%),radial-gradient(135%_92%_at_50%_0%,rgba(255,255,255,0.28)_0%,transparent_54%),radial-gradient(135%_92%_at_50%_100%,rgba(148,163,184,0.09)_0%,transparent_60%)] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.045)_0%,rgba(255,255,255,0.018)_16%,transparent_30%),radial-gradient(135%_92%_at_50%_0%,rgba(255,255,255,0.05)_0%,transparent_56%),radial-gradient(135%_92%_at_50%_100%,rgba(0,0,0,0.18)_0%,transparent_62%)]",
              glassAccent === "soft" &&
                "bg-[linear-gradient(180deg,rgba(255,255,255,0.26)_0%,rgba(255,255,255,0.14)_16%,rgba(255,255,255,0.05)_34%,transparent_52%),radial-gradient(135%_96%_at_50%_0%,rgba(255,255,255,0.32)_0%,transparent_54%),radial-gradient(135%_96%_at_50%_100%,rgba(148,163,184,0.11)_0%,transparent_62%)] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.055)_0%,rgba(255,255,255,0.022)_16%,transparent_32%),radial-gradient(135%_96%_at_50%_0%,rgba(255,255,255,0.06)_0%,transparent_56%),radial-gradient(135%_96%_at_50%_100%,rgba(0,0,0,0.22)_0%,transparent_64%)]",
              glassAccent === "balanced" &&
                "bg-[linear-gradient(180deg,rgba(255,255,255,0.3)_0%,rgba(255,255,255,0.16)_16%,rgba(255,255,255,0.06)_36%,transparent_54%),radial-gradient(140%_100%_at_50%_0%,rgba(255,255,255,0.36)_0%,transparent_54%),radial-gradient(140%_100%_at_50%_100%,rgba(148,163,184,0.13)_0%,transparent_64%)] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.065)_0%,rgba(255,255,255,0.026)_16%,transparent_34%),radial-gradient(140%_100%_at_50%_0%,rgba(255,255,255,0.075)_0%,transparent_56%),radial-gradient(140%_100%_at_50%_100%,rgba(0,0,0,0.24)_0%,transparent_66%)]"
            )}
            style={{ borderRadius: "inherit" }}
          />
        ) : null}

        <div className="relative z-[1]">
          {IconComponent &&
          (iconPosition === "top-left" || iconPosition === "top-right")
            ? renderIconBlock()
            : null}
          {children}
          {IconComponent &&
          (iconPosition === "bottom-left" || iconPosition === "bottom-right")
            ? renderIconBlock()
            : null}
        </div>

        {showRipple ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden"
            style={{ borderRadius: "inherit" }}
          >
            <MaterialRipple variant={variant} effect={effect} />
          </div>
        ) : null}
      </Comp>
    );
  }
);

Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof StockCardHeader>
>(({ className, ...props }, ref) => (
  <StockCardHeader ref={ref} className={cn("px-0 space-y-4 pb-2.5", className)} {...props} />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof StockCardTitle>
>(({ className, ...props }, ref) => (
  <StockCardTitle
    ref={ref}
    className={cn("text-xl leading-none tracking-tight", className)}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof StockCardDescription>
>(({ className, ...props }, ref) => (
  <StockCardDescription
    ref={ref}
    className={cn("text-sm leading-6 text-muted-foreground", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof StockCardContent>
>(({ className, ...props }, ref) => (
  <StockCardContent ref={ref} className={cn("px-0 space-y-4", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof StockCardFooter>
>(({ className, ...props }, ref) => (
  <StockCardFooter
    ref={ref}
    className={cn("px-0 pt-4 border-t border-border", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
