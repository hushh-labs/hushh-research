import * as React from "react";
import { type IconWeight } from "@phosphor-icons/react";

import {
  Button as StockButton,
  buttonVariants as stockButtonVariants,
} from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type MorphyButtonBaseProps } from "@/lib/morphy-ux/types";
import { getVariantStyles } from "@/lib/morphy-ux/utils";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { useIconWeight } from "@/lib/morphy-ux/icon-theme-context";

type MorphyButtonSize = "sm" | "default" | "lg" | "xl" | "icon" | "icon-sm";

export interface ButtonProps
  extends Omit<React.ComponentProps<typeof StockButton>, "variant" | "size">,
    MorphyButtonBaseProps {
  asChild?: boolean;
  size?: MorphyButtonSize;
  icon?: {
    icon: React.ComponentType<{ className?: string; weight?: IconWeight }>;
    title?: string;
    weight?: IconWeight;
    gradient?: boolean;
  };
}

function mapToStockVariant(variant: ButtonProps["variant"]) {
  if (variant === "link") return "link" as const;
  if (variant === "destructive") return "destructive" as const;
  return "ghost" as const;
}

function mapToStockSize(size: MorphyButtonSize | undefined) {
  switch (size) {
    case "sm":
      return "sm" as const;
    case "lg":
      return "lg" as const;
    case "icon":
      return "icon" as const;
    case "icon-sm":
      return "icon-sm" as const;
    default:
      return "default" as const;
  }
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "blue-gradient",
      effect = "fill",
      size = "default",
      asChild = false,
      showRipple = true,
      icon,
      fullWidth,
      loading = false,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    const iconWeight = useIconWeight();
    const IconComponent = icon?.icon;
    const isDisabled = Boolean(disabled || loading);
    const variantStyles = getVariantStyles(variant, effect);

    const stockVariant = mapToStockVariant(variant);
    const stockSize = mapToStockSize(size);
    const isXl = size === "xl";

    const getIconBoxSize = () => {
      switch (size) {
        case "sm":
          return "h-6 w-6";
        case "lg":
          return "h-10 w-10";
        case "xl":
          return "h-12 w-12";
        default:
          return "h-8 w-8";
      }
    };

    const getIconSize = () => {
      switch (size) {
        case "sm":
          return "h-3 w-3";
        case "lg":
          return "h-5 w-5";
        case "xl":
          return "h-6 w-6";
        default:
          return "h-4 w-4";
      }
    };

    const iconBoxClass = icon?.gradient
      ? "bg-gradient-to-r from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)] border-transparent"
      : "bg-transparent border-transparent";
    const shouldShowRipple = showRipple !== false;
    const iconColorClass = icon?.gradient
      ? "text-white dark:text-black"
      : variant === "none" && effect !== "fill"
        ? "text-[var(--morphy-primary-start)]"
        : "text-inherit";

    const renderContent = (contentChildren: React.ReactNode) => (
      <>
        <span className="relative z-0 inline-flex items-center justify-center text-inherit">
          {IconComponent ? (
            <span
              className={cn(
                "mr-2.5 flex items-center justify-center rounded-lg border",
                getIconBoxSize(),
                iconBoxClass
              )}
            >
              <IconComponent
                className={cn(getIconSize(), iconColorClass)}
                weight={icon?.weight || iconWeight}
              />
            </span>
          ) : null}
          {contentChildren}
        </span>
        {shouldShowRipple ? (
          <MaterialRipple
            variant={variant}
            effect={effect}
            disabled={isDisabled}
            className="z-10"
          />
        ) : null}
      </>
    );

    if (asChild) {
      const child = React.Children.only(children) as React.ReactElement<{
        children?: React.ReactNode;
        className?: string;
      }>;
      const slottedContent = renderContent(child.props.children);

      return (
        <StockButton
          ref={ref}
          asChild
          variant={stockVariant}
          size={stockSize}
          disabled={isDisabled}
          data-loading={loading || undefined}
          aria-busy={loading || undefined}
          className={cn(
            "relative overflow-hidden transition-[border-color,box-shadow,background-color] duration-200",
            variantStyles,
            effect === "fill" && variant !== "none" && variant !== "link"
              ? "border border-transparent"
              : "border-transparent",
            isXl ? "h-16 px-12 text-lg" : "",
            fullWidth ? "w-full" : "",
            loading ? "cursor-wait" : "",
            className
          )}
          {...props}
        >
          {React.cloneElement(child, {
            className: cn("relative overflow-hidden", child.props.className),
            children: slottedContent,
          })}
        </StockButton>
      );
    }

    const content = renderContent(children);

    return (
      <StockButton
        ref={ref}
        asChild={asChild}
        variant={stockVariant}
        size={stockSize}
        disabled={isDisabled}
        data-loading={loading || undefined}
        aria-busy={loading || undefined}
        className={cn(
          "relative overflow-hidden transition-[border-color,box-shadow,background-color] duration-200",
          variantStyles,
          effect === "fill" && variant !== "none" && variant !== "link"
            ? "border border-transparent"
            : "border-transparent",
          isXl ? "h-16 px-12 text-lg" : "",
          fullWidth ? "w-full" : "",
          loading ? "cursor-wait" : "",
          className
        )}
        {...props}
      >
        {content}
      </StockButton>
    );
  }
);

Button.displayName = "Button";

const buttonVariants = stockButtonVariants;

export { Button, buttonVariants };
