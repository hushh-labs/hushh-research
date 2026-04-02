"use client";

import { Children, cloneElement, isValidElement } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
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

const INTERACTIVE_HTML_TAGS = new Set([
  "a",
  "button",
  "details",
  "input",
  "option",
  "select",
  "summary",
  "textarea",
]);

function isKnownInteractiveComponent(type: unknown): boolean {
  if (typeof type !== "function" && typeof type !== "object") {
    return false;
  }
  const typedComponent = type as { displayName?: string; name?: string };
  const displayName =
    typeof typedComponent.displayName === "string" && typedComponent.displayName.trim()
      ? typedComponent.displayName
      : typeof typedComponent.name === "string"
        ? typedComponent.name
        : "";
  const normalized = displayName.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return [
    "button",
    "checkbox",
    "combobox",
    "dropdownmenutrigger",
    "input",
    "menubutton",
    "radio",
    "select",
    "switch",
    "textarea",
  ].includes(normalized);
}

function containsInteractiveNode(node: ReactNode): boolean {
  return Children.toArray(node).some((child) => {
    if (!isValidElement(child)) {
      return false;
    }

    if (typeof child.type === "string" && INTERACTIVE_HTML_TAGS.has(child.type)) {
      return true;
    }

    if (isKnownInteractiveComponent(child.type)) {
      return true;
    }

    const childProps = child.props as { children?: ReactNode };
    return containsInteractiveNode(childProps.children);
  });
}

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
        "relative grid w-full rounded-[var(--radius-sm)] border border-black/[0.10] bg-[linear-gradient(180deg,rgba(10,10,12,0.085),rgba(10,10,12,0.045))] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.98),0_14px_34px_rgba(15,23,42,0.08)] dark:border-white/14 dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.12),rgba(255,255,255,0.08))] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_14px_34px_rgba(0,0,0,0.28)] [grid-template-columns:repeat(var(--segmented-mobile-cols),minmax(0,1fr))] sm:[grid-template-columns:repeat(var(--segmented-desktop-cols),minmax(0,1fr))]",
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
            aria-pressed={isActive}
            data-state={isActive ? "active" : "inactive"}
            onClick={() => {
              if (isActive) return;
              onValueChange(option.value);
            }}
            className={cn(
              "relative isolate min-h-9 overflow-hidden rounded-[calc(var(--radius-sm)-4px)] border px-3 py-1.5 text-center transition-all duration-200 sm:min-h-10 sm:px-3.5",
              isActive
                ? "z-10 -translate-y-px border-black/[0.14] bg-[linear-gradient(180deg,rgba(255,255,255,1),rgba(241,245,250,0.98))] text-foreground font-semibold ring-1 ring-black/[0.05] shadow-[0_16px_34px_rgba(15,23,42,0.16),inset_0_1px_0_rgba(255,255,255,0.96),0_0_0_1px_rgba(255,255,255,0.55)] dark:border-white/18 dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.18),rgba(255,255,255,0.09))] dark:ring-white/[0.04] dark:shadow-[0_16px_34px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.16),0_0_0_1px_rgba(255,255,255,0.04)]"
                : "border-transparent bg-transparent text-muted-foreground hover:border-black/[0.08] hover:bg-white/75 hover:text-foreground dark:hover:border-white/10 dark:hover:bg-white/[0.10]"
            )}
          >
            <span className="relative z-0 block truncate text-xs font-medium tracking-tight sm:text-sm">
              {option.label}
            </span>
            <MaterialRipple variant="none" effect="fade" className="z-10" />
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
        "relative isolate p-px [--settings-group-radius:20px] rounded-[var(--radius-md)] border-0 bg-card shadow-[var(--app-card-shadow-standard)]",
        !embedded && "sm:rounded-[22px]"
      )}
    >
      {clipShell}
    </div>
  );

  return (
    <section className={cn("space-y-[var(--settings-group-stack-gap)]", className)}>
      {eyebrow || title || description ? (
        <div className="space-y-[var(--settings-heading-stack-gap)] px-0.5 sm:px-1">
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
  children,
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
  children?: ReactNode;
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
  const resolvedAsChild = asChild && isValidElement(children);
  const isInteractive = !disabled && (typeof onClick === "function" || resolvedAsChild);
  const shouldStackTrailing = stackTrailingOnMobile && Boolean(trailing) && !chevron;
  const hasInteractiveTrailing = containsInteractiveNode(trailing);
  const splitPrimaryAction = Boolean(!asChild && onClick && hasInteractiveTrailing);
  const Comp = resolvedAsChild ? Slot.Root : onClick && !splitPrimaryAction ? "button" : "div";
  const rowRadiusClassName =
    "[--settings-row-top-radius:0px] [--settings-row-bottom-radius:0px] first:[--settings-row-top-radius:calc(var(--settings-group-radius)-1px)] last:[--settings-row-bottom-radius:calc(var(--settings-group-radius)-1px)] [border-top-left-radius:var(--settings-row-top-radius)] [border-top-right-radius:var(--settings-row-top-radius)] [border-bottom-left-radius:var(--settings-row-bottom-radius)] [border-bottom-right-radius:var(--settings-row-bottom-radius)]";
  const rowShellClassName = cn(
    "group/settings-row relative isolate overflow-hidden bg-transparent",
    rowRadiusClassName,
    disabled && "cursor-not-allowed opacity-60",
    className
  );
  const mainContent = (
    <div
      className={cn(
        "relative z-0 flex min-w-0 gap-[var(--settings-row-gap)]",
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
  );
  const trailingContent = trailing || chevron ? (
      <div
        className={cn(
          "relative z-0 flex max-w-full shrink-0 items-center justify-end self-center gap-2.5 pr-0.5 sm:pr-1",
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
  ) : null;

  const sharedClassName = cn(
    "relative isolate grid w-full appearance-none overflow-hidden border-0 bg-transparent px-[var(--settings-row-px)] py-[var(--settings-row-py)] text-left outline-hidden ring-0 [-webkit-tap-highlight-color:transparent]",
    shouldStackTrailing
      ? "grid-cols-1 gap-y-[var(--settings-row-stack-gap)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-[var(--settings-row-gap)] sm:gap-y-0"
      : "grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[var(--settings-row-gap)]",
    isInteractive &&
      "transition-[border-color,box-shadow] focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0"
  );
  const asChildContent =
    resolvedAsChild
      ? cloneElement(children as ReactElement, undefined, mainContent, trailingContent)
      : children;

  if (splitPrimaryAction) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={rowShellClassName}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 z-[1] bg-transparent transition-[background-color]",
            "group-hover/settings-row:bg-foreground/[0.04] group-active/settings-row:bg-foreground/[0.065]"
          )}
        />
        <div
          className={cn(
            "relative z-10 grid w-full px-[var(--settings-row-px)] py-[var(--settings-row-py)]",
            shouldStackTrailing
              ? "grid-cols-1 gap-y-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-3"
              : "grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3"
          )}
        >
          <div className="min-w-0">{mainContent}</div>
          {trailingContent ? (
            <div onClick={(e) => e.stopPropagation()}>
              {trailingContent}
            </div>
          ) : null}
        </div>
        <MaterialRipple variant="none" effect="fade" disabled={disabled} className="z-10" />
      </button>
    );
  }

  if (resolvedAsChild) {
    return (
      <div className={rowShellClassName}>
        {isInteractive ? (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0 z-[1] bg-transparent transition-[background-color]",
              "group-hover/settings-row:bg-foreground/[0.04] group-active/settings-row:bg-foreground/[0.065]"
            )}
          />
        ) : null}
        <Comp
          {...(!resolvedAsChild ? { "aria-disabled": disabled || undefined } : {})}
          className={sharedClassName}
        >
          {asChildContent}
        </Comp>
      </div>
    );
  }

  return (
    <div className={rowShellClassName}>
      {isInteractive ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 z-[1] bg-transparent transition-[background-color]",
            "group-hover/settings-row:bg-foreground/[0.04] group-active/settings-row:bg-foreground/[0.065]"
          )}
        />
      ) : null}
      <Comp
        {...(!asChild && onClick
          ? { type: "button" as const, onClick, disabled }
          : { "aria-disabled": disabled || undefined })}
        className={sharedClassName}
      >
        <>
          {mainContent}
          {trailingContent}
        </>
        {isInteractive ? (
          <MaterialRipple
            variant="none"
            effect="fade"
            disabled={disabled}
            className="z-10"
          />
        ) : null}
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
          <DrawerHeader className="sticky top-0 z-10 border-b border-border/90 bg-background px-4 py-3 text-left sm:px-5 sm:py-4">
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
        className="w-full border-l border-border/90 !bg-background p-0 sm:max-w-[480px]"
        style={{ backgroundColor: "var(--background)" }}
      >
        <SheetHeader className="sticky top-0 z-10 border-b border-border/90 bg-background px-6 py-4">
          <SheetTitle className="text-base font-semibold tracking-tight">
            {title}
          </SheetTitle>
          {description ? (
            <SheetDescription className="text-sm leading-6">
              {description}
            </SheetDescription>
          ) : null}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto bg-background px-4 pb-8 pt-4 sm:px-5 sm:pt-5">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
