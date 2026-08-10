"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";

// Lean top-bar control surface. Mirrors the ThemeToggleLean pill exactly:
// a soft translucent track (no sky border, no heavy shadow, no blur) so every
// top-app-bar control (back button, theme toggle, title pill, future actions)
// shares one minimal, symmetric aesthetic. h-9 / rounded-full / px to match.
// Every top-bar control shares one lean translucent track that matches the
// bottom nav pill and the back button exactly: soft fill (bg-black/[0.05]
// light, bg-white/[0.07] dark), no border, no shadow, no blur. Icon controls
// carry the muted eyebrow tone on the stroke and warm to full foreground on
// hover; pill controls add horizontal padding + label text.
const shellActionSurfaceVariants = cva(
  "shell-action-surface group/shell-action relative isolate inline-flex overflow-hidden rounded-full border border-[color:var(--app-glass-border)] bg-[color:var(--app-glass-surface)] shadow-[var(--app-glass-shadow)] transition-[color,background-color,transform] duration-200 hover:bg-[color:var(--app-shell-surface-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        icon:
          "h-9 w-9 items-center justify-center text-muted-foreground hover:text-foreground active:scale-90",
        pill:
          "h-9 min-w-0 max-w-full items-center justify-center gap-1.5 px-3.5 text-[14px] font-semibold tracking-normal text-foreground active:scale-[0.97] sm:gap-2 sm:px-4 sm:text-base",
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
          className={cn(
            "pointer-events-none relative z-10 inline-flex min-w-0 max-w-full items-center justify-center",
            variant === "pill" && "gap-1.5 sm:gap-2",
            contentClassName
          )}
        >
          {children}
        </span>
        <MaterialRipple variant="blue" effect="glass" className={cn("z-10", rippleClassName)} />
      </button>
      {badge ? (
        <span
          className={cn(
            // A fixed corner overlay on the icon's own box, not the wrapper:
            // the trigger's footprint never changes size when a badge
            // appears or disappears, so sibling shell actions never shift.
            "pointer-events-none absolute -right-1 -top-1 z-20",
            badgeClassName
          )}
        >
          {badge}
        </span>
      ) : null}
    </span>
  );
});
