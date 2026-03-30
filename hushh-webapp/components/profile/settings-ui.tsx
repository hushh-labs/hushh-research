"use client";

import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { Slot } from "radix-ui";

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

export function SettingsSegmentedTabs({
  value,
  onValueChange,
  options,
  mobileColumns,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  mobileColumns?: number;
  className?: string;
}) {
  const resolvedDesktopColumns = Math.max(options.length, 1);
  const resolvedMobileColumns = Math.max(mobileColumns ?? resolvedDesktopColumns, 1);

  return (
    <div
      className={cn(
        "relative grid w-full rounded-full border border-border/70 bg-background/68 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.16)] [grid-template-columns:repeat(var(--segmented-mobile-cols),minmax(0,1fr))] sm:[grid-template-columns:repeat(var(--segmented-desktop-cols),minmax(0,1fr))]",
        className
      )}
      style={
        {
          "--segmented-mobile-cols": String(resolvedMobileColumns),
          "--segmented-desktop-cols": String(resolvedDesktopColumns),
        } as CSSProperties
      }
    >
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              if (isActive) return;
              onValueChange(option.value);
            }}
            className={cn(
              "relative min-h-9 overflow-hidden rounded-full px-2 py-1.5 text-center transition-[background-color,color,box-shadow] sm:min-h-10 sm:px-2.5",
              isActive
                ? "bg-background text-foreground shadow-[0_10px_24px_-18px_rgba(15,23,42,0.34)] dark:bg-background/96"
                : "bg-transparent text-foreground/68 hover:bg-background/48 hover:text-foreground dark:hover:bg-background/18"
            )}
          >
            <span className="relative z-10 block truncate text-[11px] font-medium tracking-tight sm:text-[13px]">
              {option.label}
            </span>
            <MaterialRipple variant="none" effect="fade" className="z-0" />
          </button>
        );
      })}
    </div>
  );
}

export function SettingsGroup({
  eyebrow,
  title,
  description,
  children,
  embedded = false,
  className,
}: {
  eyebrow?: string;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  embedded?: boolean;
  className?: string;
}) {
  const clipShell = (
    <div className="relative isolate overflow-hidden rounded-[calc(var(--settings-group-radius)-1px)]">
      <div className="relative isolate divide-y divide-border/60">{children}</div>
    </div>
  );

  const shell = (
    <div
      className={cn(
        "relative isolate p-px [--settings-group-radius:20px] rounded-[20px] border border-border/60 bg-background/68 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]",
        !embedded && "sm:rounded-[22px]"
      )}
    >
      {clipShell}
    </div>
  );

  return (
    <section className={cn("space-y-2", className)}>
      {eyebrow || title || description ? (
        <div className="space-y-1 px-0.5 sm:px-1">
          {eyebrow ? (
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          {title ? (
            <h2 className="text-pretty text-[13px] font-semibold tracking-tight text-foreground [overflow-wrap:anywhere] sm:text-[14px]">
              {title}
            </h2>
          ) : null}
          {description ? (
            <p className="max-w-2xl text-[11px] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere] sm:text-[12px]">
              {description}
            </p>
          ) : null}
        </div>
      ) : null}
      {shell}
    </section>
  );
}

export function SettingsRow({
  asChild = false,
  icon,
  leading,
  title,
  description,
  trailing,
  onClick,
  chevron = false,
  disabled = false,
  tone = "default",
  stackTrailingOnMobile = false,
  className,
}: {
  asChild?: boolean;
  icon?: LucideIcon;
  leading?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  chevron?: boolean;
  disabled?: boolean;
  tone?: "default" | "destructive";
  stackTrailingOnMobile?: boolean;
  className?: string;
}) {
  const isInteractive = !disabled && (typeof onClick === "function" || asChild);
  const shouldStackTrailing = stackTrailingOnMobile && Boolean(trailing) && !chevron;
  const Comp = asChild ? Slot.Root : onClick ? "button" : "div";
  const rowRadiusClassName =
    "[--settings-row-top-radius:0px] [--settings-row-bottom-radius:0px] first:[--settings-row-top-radius:calc(var(--settings-group-radius)-1px)] last:[--settings-row-bottom-radius:calc(var(--settings-group-radius)-1px)] [border-top-left-radius:var(--settings-row-top-radius)] [border-top-right-radius:var(--settings-row-top-radius)] [border-bottom-left-radius:var(--settings-row-bottom-radius)] [border-bottom-right-radius:var(--settings-row-bottom-radius)]";
  const rowShellClassName = cn(
    "group/settings-row relative isolate overflow-hidden bg-transparent",
    rowRadiusClassName,
    disabled && "cursor-not-allowed opacity-60",
    className
  );
  const content = (
    <>
      <div
        className={cn(
          "pointer-events-none relative z-10 flex min-w-0 gap-2.5 sm:gap-3",
          shouldStackTrailing ? "items-start sm:items-center" : "items-center"
        )}
      >
        {leading ? (
          <span className="inline-flex shrink-0 self-center">{leading}</span>
        ) : icon ? (
          <span
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center self-center rounded-2xl bg-muted/65 text-muted-foreground sm:h-10 sm:w-10",
              tone === "destructive" && "bg-destructive/10 text-destructive"
            )}
          >
            <Icon icon={icon} size="md" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1 space-y-0.5">
          <div
            className={cn(
              "text-[13px] font-medium tracking-tight text-foreground [overflow-wrap:anywhere] sm:text-[14px]",
              tone === "destructive" && "text-destructive"
            )}
          >
            {title}
          </div>
          {description ? (
            <div className="text-[11px] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere] sm:text-[12px]">
              {description}
            </div>
          ) : null}
        </div>
      </div>
      {trailing || chevron ? (
        <div
          className={cn(
            "relative z-10 flex max-w-full shrink-0 items-center justify-end self-center gap-2",
            shouldStackTrailing &&
              "w-full justify-start pl-[2.65rem] pt-1 sm:w-auto sm:justify-end sm:pl-0 sm:pt-0"
          )}
        >
          {trailing}
          {chevron ? (
            <ChevronRight
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground/90 transition-transform",
                isInteractive && "group-hover:translate-x-0.5"
              )}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );

  const sharedClassName = cn(
    "relative z-10 grid w-full appearance-none border-0 bg-transparent px-3 py-3.5 text-left outline-hidden ring-0 [-webkit-tap-highlight-color:transparent] sm:px-4 sm:py-4",
    shouldStackTrailing
      ? "grid-cols-1 gap-y-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-3 sm:gap-y-0"
      : "grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3",
    isInteractive &&
      "transition-[border-color,box-shadow] focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0"
  );

  return (
    <div className={rowShellClassName}>
      {isInteractive ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 z-[1] bg-transparent transition-[background-color]",
            "group-hover/settings-row:bg-muted/36 group-active/settings-row:bg-muted/48"
          )}
        />
      ) : null}
      {isInteractive ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-[2] overflow-hidden rounded-[inherit]">
          <MaterialRipple
            variant="none"
            effect="fade"
            disabled={disabled}
            className="z-[2]"
          />
        </div>
      ) : null}
      <Comp
        {...(!asChild && onClick
          ? { type: "button" as const, onClick, disabled }
          : !asChild
            ? { "aria-disabled": disabled || undefined }
            : {})}
        className={sharedClassName}
      >
        {content}
      </Comp>
    </div>
  );
}

export function SettingsDetailPanel({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="h-[100dvh] max-h-[100dvh] rounded-none border-none bg-background">
          <DrawerHeader className="sticky top-0 z-10 border-b border-border/90 bg-background/96 px-4 py-3 text-left backdrop-blur-xl sm:px-5 sm:py-4">
            <DrawerTitle className="text-base font-semibold tracking-tight">
              {title}
            </DrawerTitle>
            {description ? (
              <DrawerDescription className="text-sm leading-5 sm:leading-6">
                {description}
              </DrawerDescription>
            ) : null}
          </DrawerHeader>
          <div className="flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-3 sm:px-4 sm:pt-4">
            {children}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal>
      <SheetContent
        side="right"
        className="w-full border-l border-border/90 p-0 sm:max-w-[480px]"
      >
        <SheetHeader className="sticky top-0 z-10 border-b border-border/90 bg-background/96 px-6 py-4 backdrop-blur-xl">
          <SheetTitle className="text-base font-semibold tracking-tight">
            {title}
          </SheetTitle>
          {description ? (
            <SheetDescription className="text-sm leading-6">
              {description}
            </SheetDescription>
          ) : null}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-8 pt-4 sm:px-5 sm:pt-5">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
