"use client";

import { Children, cloneElement, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { Slot } from "@radix-ui/react-slot";

import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Icon, SegmentedTabs } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

type ChildWithProps = ReactElement<{ className?: string; children?: ReactNode }>;

function containsInteractiveNode(node: ReactNode, depth = 0): boolean {
  if (depth > 5) return false;
  return Children.toArray(node).some((child) => {
    if (!isValidElement(child)) return false;
    const type = child.type as any;
    if (typeof type === "string" && ["button", "a", "input", "select", "textarea"].includes(type)) return true;
    const displayName = type?.displayName?.toLowerCase() || "";
    if (displayName.includes("button") || displayName.includes("switch") || displayName.includes("checkbox")) return true;
    return containsInteractiveNode((child.props as any)?.children, depth + 1);
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
}: {
  eyebrow?: string;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  embedded?: boolean;
  className?: string;
}) {
  return (
    <section className={cn("w-full space-y-[var(--settings-group-stack-gap)]", className)}>
      {(eyebrow || title || description) && (
        <div className="space-y-[var(--settings-heading-stack-gap)] px-1">
          {eyebrow && (
            <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/80">
              {eyebrow}
            </p>
          )}
          {title && (
            <h2 className="text-[14px] font-semibold tracking-tight text-foreground sm:text-[15px]">
              {title}
            </h2>
          )}
          {description && (
            <p className="max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      )}
      <div
        className={cn(
          "relative isolate overflow-hidden border border-border/50 bg-card/30 backdrop-blur-sm",
          "divide-y divide-border/40 rounded-[var(--app-card-radius-feature)]",
          embedded && "border-none bg-transparent"
        )}
      >
        {children}
      </div>
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
}) {
  const isMobile = useIsMobile();
  const hasInteractiveTrailing = containsInteractiveNode(trailing);
  const isClickable = !!onClick && !disabled;

  const Comp = asChild ? Slot : isClickable ? "button" : "div";

  const voiceProps = {
    "data-voice-control-id": voiceControlId,
    "data-voice-action-id": voiceActionId,
    "data-voice-label": voiceLabel || (typeof title === "string" ? title : undefined),
    "data-voice-purpose": voicePurpose || (typeof description === "string" ? description : undefined),
  };

  const mainContent = (
    <div className="flex min-w-0 flex-1 items-center gap-3 py-3 sm:gap-4">
      {leading || (icon && (
        <div className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground",
          tone === "destructive" && "bg-destructive/10 text-destructive"
        )}>
          <Icon icon={icon} size="md" />
        </div>
      ))}
      <div className="min-w-0 flex-1">
        <div className={cn("text-sm font-medium", tone === "destructive" && "text-destructive")}>
          {title}
        </div>
        {description && (
          <div className="line-clamp-2 text-[12px] text-muted-foreground">{description}</div>
        )}
      </div>
    </div>
  );

  const trailingSection = (trailing || chevron) && (
    <div className={cn(
      "flex shrink-0 items-center gap-2 pl-2 pr-4",
      stackTrailingOnMobile && isMobile && "w-full pb-3 pl-11"
    )}>
      {trailing}
      {chevron && <ChevronRight className="h-4 w-4 opacity-40" />}
    </div>
  );

  const asChildContent =
    asChild && isValidElement(children)
      ? cloneElement(children as ChildWithProps, {
        className: cn((children.props as any)?.className, "w-full flex items-center"),
        children: (
          <>
            {mainContent}
            {trailingSection}
          </>
        ),
      })
      : children;

  return (
    <div className={cn(
      "group relative flex flex-wrap items-center overflow-hidden transition-colors",
      isClickable && "hover:bg-foreground/[0.02] active:bg-foreground/[0.04]",
      className
    )}>
      <Comp
        {...(isClickable ? { onClick, type: "button" } : {})}
        className={cn(
          "flex min-w-0 flex-1 items-center text-left outline-none border-none bg-transparent px-4",
          isClickable ? "cursor-pointer select-none" : "cursor-default"
        )}
        {...voiceProps}
      >
        {asChild ? asChildContent : (
          <>
            {mainContent}
            {trailingSection}
          </>
        )}
        {isClickable && <MaterialRipple className="z-0" />}
      </Comp>

      <div className={cn("relative z-10", !hasInteractiveTrailing && "pointer-events-none")}>
        {!asChild && trailingSection}
      </div>
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

  // FIX: Moved JSX to a variable instead of a component declaration to pass linting
  const headerLayout = (
    <>
      <div className="text-base font-semibold tracking-tight">{title}</div>
      {description && (
        <div className="text-sm text-muted-foreground mt-0.5">{description}</div>
      )}
    </>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="flex h-[96dvh] flex-col overflow-hidden rounded-t-[32px]">
          <DrawerHeader className="border-b bg-background px-6 py-4 text-left shrink-0">
            <DrawerTitle>{headerLayout}</DrawerTitle>
          </DrawerHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4 pb-12">
            {children}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl overflow-hidden p-0 gap-0">
        <DialogHeader className="border-b bg-background px-8 py-5 text-left shrink-0">
          <DialogTitle>{headerLayout}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto px-8 py-6">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}