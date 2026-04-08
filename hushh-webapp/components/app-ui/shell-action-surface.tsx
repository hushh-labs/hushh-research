"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";

const shellActionSurfaceVariants = cva(
  "group/shell-action relative isolate inline-flex overflow-hidden rounded-full border border-[color:var(--app-shell-surface-border)] bg-[color:var(--app-shell-surface-bg)] bg-[image:var(--app-shell-surface-fill)] bg-[length:100%_100%] bg-no-repeat text-[color:var(--app-shell-surface-foreground)] shadow-[var(--app-shell-surface-shadow)] backdrop-blur-[var(--app-shell-surface-blur)] transition-[background-color,transform,box-shadow,border-color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/55 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        icon: "h-10 w-10 items-center justify-center hover:scale-[1.035] hover:bg-[color:var(--app-shell-surface-bg-hover)] active:scale-[0.965]",
        pill: "min-h-10 min-w-0 max-w-full items-center justify-center gap-1.5 px-3 py-1.5 text-[14px] font-semibold tracking-tight hover:bg-[color:var(--app-shell-surface-bg-hover)] sm:gap-2 sm:px-4 sm:text-base",
      },
    },
    defaultVariants: {
      variant: "icon",
    },
  }
);

export const SHELL_ICON_BUTTON_CLASSNAME = shellActionSurfaceVariants({ variant: "icon" });
export const SHELL_PILL_TRIGGER_CLASSNAME = shellActionSurfaceVariants({ variant: "pill" });

interface ShellActionSurfaceProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof shellActionSurfaceVariants> {
  badge?: React.ReactNode;
  badgeClassName?: string;
  contentClassName?: string;
  rippleClassName?: string;
  wrapperClassName?: string;
}

export const ShellActionSurface = React.forwardRef<
  HTMLButtonElement,
  ShellActionSurfaceProps
>(function ShellActionSurface(
  {
    variant = "icon",
    className,
    wrapperClassName,
    contentClassName,
    rippleClassName,
    badge,
    badgeClassName,
    children,
    type = "button",
    ...props
  },
  ref
) {
  return (
    <span className={cn("relative inline-flex shrink-0 overflow-visible align-middle", wrapperClassName)}>
      <button
        ref={ref}
        type={type}
        className={cn(shellActionSurfaceVariants({ variant }), className)}
        {...props}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 z-[1] rounded-full bg-transparent transition-[background-color]",
            "group-hover/shell-action:bg-foreground/[0.04] group-active/shell-action:bg-foreground/[0.065]",
            "dark:group-hover/shell-action:bg-white/[0.075] dark:group-active/shell-action:bg-white/[0.12]"
          )}
        />
        <span
          className={cn(
            "pointer-events-none relative z-10 inline-flex min-w-0 max-w-full items-center justify-center",
            variant === "pill" && "gap-1.5 sm:gap-2",
            contentClassName
          )}
        >
          {children}
        </span>
        <MaterialRipple variant="none" effect="fade" className={cn("z-10", rippleClassName)} />
      </button>
      {badge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 top-0 z-20 translate-x-[24%] -translate-y-[22%]",
            badgeClassName
          )}
        >
          {badge}
        </span>
      ) : null}
    </span>
  );
});
