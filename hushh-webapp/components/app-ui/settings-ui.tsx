"use client";

import { Children, cloneElement, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Icon, SegmentedTabs } from "@/lib/morphy-ux/ui";
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

export const SettingsSegmentedTabs = SegmentedTabs;

export function SettingsGroup({
  eyebrow,
  title,
  description,
  children,
  embedded = false,
  className,
  testId = "settings-group",
}: {
  eyebrow?: string;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  embedded?: boolean;
  className?: string;
  testId?: string;
}) {
  const shell = (
    <div
      className={cn(
        "relative isolate [--settings-group-radius:30px] overflow-hidden rounded-[calc(var(--app-card-radius-feature)+6px)]",
        "border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]",
        !embedded && "sm:rounded-[var(--app-card-radius-feature)]"
      )}
    >
      <div className="relative isolate divide-y divide-border/60">{children}</div>
    </div>
  );

  return (
    <section className={cn("w-full space-y-[var(--settings-group-stack-gap)]", className)} data-testid={testId}>
      {eyebrow || title || description ? (
        <div className="space-y-[var(--settings-heading-stack-gap)] px-0.5 sm:px-1">
          {eyebrow || title ? (
            <div
              role="heading"
              aria-level={embedded ? 3 : 2}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-pretty text-[15px] font-semibold leading-tight tracking-tight text-foreground [overflow-wrap:anywhere] sm:text-[16px]"
            >
              {eyebrow ? (
                <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground sm:text-[11px]">
                  {eyebrow}
                </span>
              ) : null}
              {title ? <span>{title}</span> : null}
            </div>
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
  voiceControlId,
  voiceActionId,
  voiceLabel,
  voicePurpose,
  testId = "settings-row",
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
  voiceControlId?: string;
  voiceActionId?: string;
  voiceLabel?: string;
  voicePurpose?: string;
  testId?: string;
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
    "group/settings-row relative isolate overflow-hidden bg-[color:var(--app-list-row-surface)] sm:bg-transparent",
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
  const primaryActionClassName = cn(
    "relative isolate min-w-0 overflow-hidden rounded-[inherit] border-0 bg-transparent px-[var(--settings-row-px)] py-[var(--settings-row-py)] text-left outline-hidden ring-0 transition-[border-color,box-shadow] [-webkit-tap-highlight-color:transparent] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
  );
  const voiceProps = {
    "data-voice-control-id": voiceControlId || undefined,
    "data-voice-action-id": voiceActionId || undefined,
    "data-voice-label": voiceLabel || (typeof title === "string" ? title : undefined),
    "data-voice-purpose": voicePurpose || (typeof description === "string" ? description : undefined),
  };
  const asChildContent =
    resolvedAsChild
      ? cloneElement(children as ReactElement, undefined, mainContent, trailingContent)
      : children;

  if (splitPrimaryAction) {
    return (
      <div className={rowShellClassName} data-testid={testId}>
        <div
          className={cn(
            "relative z-10 grid w-full px-[var(--settings-row-px)] py-[var(--settings-row-py)]",
            shouldStackTrailing
              ? "grid-cols-1 gap-y-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-3"
              : "grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3"
          )}
        >
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={primaryActionClassName}
            {...voiceProps}
          >
            {mainContent}
            <MaterialRipple
              variant="none"
              effect="fade"
              disabled={disabled}
              className="z-10"
            />
          </button>
          {trailingContent ? (
            <div onClick={(e) => e.stopPropagation()}>
              {trailingContent}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (resolvedAsChild) {
    return (
      <div className={rowShellClassName} data-testid={testId}>
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
          {...voiceProps}
        >
          {asChildContent}
        </Comp>
      </div>
    );
  }

  return (
    <div className={rowShellClassName} data-testid={testId}>
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
        {...voiceProps}
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
  desktopMaxWidthClassName,
  desktopMaxWidth,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  desktopMaxWidthClassName?: string;
  desktopMaxWidth?: string;
}) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} modal>
        <DrawerContent
          className="h-[100dvh] max-h-[100dvh] rounded-none border-none bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-feature)]"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
        >
          <DrawerHeader className="sticky top-0 z-10 border-b border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-3 text-left sm:px-5 sm:py-4">
            <DrawerTitle className="text-base font-semibold tracking-tight">
              {title}
            </DrawerTitle>
            <DrawerDescription
              className={cn(
                "text-sm leading-5 sm:leading-6",
                !description && "sr-only"
              )}
            >
              {description ?? "Settings"}
          </DrawerDescription>
          </DrawerHeader>
          <div className="flex-1 overflow-y-auto bg-[color:var(--app-card-surface-default-solid)] px-3 pb-[calc(var(--app-safe-area-bottom-effective,env(safe-area-inset-bottom,0px))+2rem)] pt-3 sm:px-4 sm:pt-4">
            {children}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent
        data-settings-detail-panel="true"
        style={desktopMaxWidth ? { maxWidth: desktopMaxWidth } : undefined}
        className={cn(
          "w-[calc(100%-1.5rem)] overflow-hidden p-0",
          desktopMaxWidthClassName || "sm:!max-w-[720px]"
        )}
      >
        <DialogHeader className="sticky top-0 z-10 border-b border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-6 py-4 text-left">
          <DialogTitle className="text-base font-semibold tracking-tight">
            {title}
          </DialogTitle>
          <DialogDescription
            className={cn("text-sm leading-6", !description && "sr-only")}
          >
            {description ?? "Settings"}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto bg-[color:var(--app-card-surface-default-solid)] px-4 pb-8 pt-4 sm:px-5 sm:pt-5">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
