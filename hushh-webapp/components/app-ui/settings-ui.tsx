"use client";

import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useEffect,
  useContext,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight, X } from "lucide-react";
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
    typeof typedComponent.displayName === "string" &&
    typedComponent.displayName.trim()
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

    if (
      typeof child.type === "string" &&
      INTERACTIVE_HTML_TAGS.has(child.type)
    ) {
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

type SettingsPresentation = {
  separatorInset?: boolean;
  density?: "compact" | "comfortable";
};

const SettingsPresentationContext = createContext<SettingsPresentation>({});

/**
 * Establishes one grouped-list presentation for a route family. Feature
 * panels can keep composing SettingsGroup/SettingsRow without restating the
 * owning shell's separator and density choices on every nested row.
 */
export function SettingsPresentationProvider({
  separatorInset,
  density,
  children,
}: SettingsPresentation & { children: ReactNode }) {
  return (
    <SettingsPresentationContext.Provider value={{ separatorInset, density }}>
      {children}
    </SettingsPresentationContext.Provider>
  );
}

const SETTINGS_ICON_TONE_CLASSNAME = {
  accent:
    "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)]",
  blue:
    "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)]",
  purple:
    "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)]",
  green:
    "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)]",
  orange:
    "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)]",
  red:
    "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)]",
  gray:
    "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)]",
} as const;

type SettingsIconTone = keyof typeof SETTINGS_ICON_TONE_CLASSNAME;

export function SettingsGroup({
  eyebrow,
  title,
  description,
  children,
  embedded = false,
  separatorInset,
  className,
  shellClassName,
  contentClassName,
  testId = "settings-group",
}: {
  eyebrow?: string;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  embedded?: boolean;
  /**
   * Opt-in iOS inset-grouped separators: hairlines that start after the leading
   * icon (aligned to the text) instead of full-width dividers. Default false
   * preserves the existing full-width `divide-y` for all other consumers.
   */
  separatorInset?: boolean;
  className?: string;
  /** Lets a bounded manager make the shared group shell a flex viewport. */
  shellClassName?: string;
  /** Lets a bounded manager make the shared row stack the scroll owner. */
  contentClassName?: string;
  testId?: string;
}) {
  const presentation = useContext(SettingsPresentationContext);
  const resolvedSeparatorInset =
    separatorInset ?? presentation.separatorInset ?? false;
  const shell = (
    <div
      data-slot="settings-group-shell"
      className={cn(
        // Inset settings groups use the compact card radius and flat grouped
        // Apple surfaces; separators inside the card carry the structure.
        "relative isolate [--settings-group-radius:var(--app-card-radius-compact)] overflow-hidden rounded-[var(--settings-group-radius)]",
        "bg-[color:var(--app-card-surface-default-solid)] shadow-none ring-0",
        !embedded && "sm:rounded-[var(--settings-group-radius)]",
        shellClassName,
      )}
    >
      <div
        className={cn(
          "relative isolate",
          resolvedSeparatorInset
            ? "group/settings-list"
            : "divide-y divide-border/60",
          contentClassName,
        )}
        data-inset-separators={resolvedSeparatorInset ? "true" : undefined}
      >
        {children}
      </div>
    </div>
  );

  return (
    <section
      className={cn(
        "w-full space-y-[var(--settings-group-stack-gap)]",
        className,
      )}
      data-testid={testId}
    >
      {eyebrow || title || description ? (
        <div className="space-y-[var(--settings-heading-stack-gap)] px-0.5 sm:px-1">
          {eyebrow || title ? (
            <div
              data-slot="settings-group-heading"
              role="heading"
              aria-level={embedded ? 3 : 2}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-pretty text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground [overflow-wrap:anywhere]"
            >
              {eyebrow ? (
                <span className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                  {eyebrow}
                </span>
              ) : null}
              {title ? <span>{title}</span> : null}
            </div>
          ) : null}
          {description ? (
            <p className="max-w-2xl text-[13px] leading-[18px] text-muted-foreground [overflow-wrap:anywhere]">
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
  iconTone = "gray",
  density,
  stackTrailingOnMobile = false,
  className,
  voiceControlId,
  voiceActionId,
  voiceLabel,
  voicePurpose,
  ariaPressed,
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
  /** Semantic leading-icon treatment; independent from destructive action tone. */
  iconTone?: SettingsIconTone;
  /** Compact, single-line settings rows for dense grouped menus. */
  density?: "compact" | "comfortable";
  stackTrailingOnMobile?: boolean;
  className?: string;
  voiceControlId?: string;
  voiceActionId?: string;
  voiceLabel?: string;
  voicePurpose?: string;
  /** Selected state for button-backed toggle rows. */
  ariaPressed?: boolean;
  testId?: string;
}) {
  const presentation = useContext(SettingsPresentationContext);
  const resolvedDensity = density ?? presentation.density ?? "comfortable";
  const resolvedAsChild = asChild && isValidElement(children);
  const isInteractive =
    !disabled && (typeof onClick === "function" || resolvedAsChild);
  const shouldStackTrailing = stackTrailingOnMobile && Boolean(trailing);
  const hasInteractiveTrailing = containsInteractiveNode(trailing);
  const splitPrimaryAction = Boolean(
    !asChild && onClick && hasInteractiveTrailing,
  );
  const Comp = resolvedAsChild
    ? Slot.Root
    : onClick && !splitPrimaryAction
      ? "button"
      : "div";
  const rowRadiusClassName =
    "[--settings-row-top-radius:0px] [--settings-row-bottom-radius:0px] first:[--settings-row-top-radius:calc(var(--settings-group-radius)-1px)] last:[--settings-row-bottom-radius:calc(var(--settings-group-radius)-1px)] [border-top-left-radius:var(--settings-row-top-radius)] [border-top-right-radius:var(--settings-row-top-radius)] [border-bottom-left-radius:var(--settings-row-bottom-radius)] [border-bottom-right-radius:var(--settings-row-bottom-radius)]";
  const separatorInsetClassName =
    // An inset separator aligns with an icon well. Rows without a leading visual
    // need a full-width hairline; otherwise the divider appears arbitrarily cut
    // off, as it did on Connect's plain-text rows.
    icon || leading
      ? "group-data-[inset-separators=true]/settings-list:after:left-[3.75rem] sm:group-data-[inset-separators=true]/settings-list:after:left-[4.25rem]"
      : "group-data-[inset-separators=true]/settings-list:after:left-0";
  const rowShellClassName = cn(
    "group/settings-row relative isolate overflow-hidden bg-[color:var(--app-list-row-surface)] sm:bg-transparent",
    resolvedDensity === "compact" && "[--settings-row-py:11px]",
    // iOS-style separator — active only inside SettingsGroup with
    // separatorInset and hidden on the final row. Its start is derived from
    // whether this row actually has a leading visual.
    "group-data-[inset-separators=true]/settings-list:after:pointer-events-none group-data-[inset-separators=true]/settings-list:after:absolute group-data-[inset-separators=true]/settings-list:after:bottom-0 group-data-[inset-separators=true]/settings-list:after:right-0 group-data-[inset-separators=true]/settings-list:after:h-px group-data-[inset-separators=true]/settings-list:after:bg-[color:var(--app-separator)] group-data-[inset-separators=true]/settings-list:after:content-[''] last:after:hidden",
    separatorInsetClassName,
    rowRadiusClassName,
    disabled && "cursor-not-allowed opacity-60",
    className,
  );
  const resolvedIconTone: SettingsIconTone =
    tone === "destructive" ? "red" : iconTone;
  const mainContent = (
    <div
      className={cn(
        "relative z-0 flex min-w-0 gap-[var(--settings-row-gap)]",
        shouldStackTrailing ? "items-start sm:items-center" : "items-center",
      )}
    >
      {leading ? (
        <span className="inline-flex shrink-0 self-center">{leading}</span>
      ) : icon ? (
        <span
          data-slot="settings-row-icon"
          data-icon-tone={resolvedIconTone}
          className={cn(
            // Keep settings icons as iOS-style rounded-square utility wells.
            // Agent artwork continues to use AgentSectionIcon, which owns the
            // larger launcher/menu geometry separately.
            "inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center self-center rounded-[8px]",
            resolvedDensity !== "compact" &&
              "sm:h-[34px] sm:w-[34px] sm:rounded-[8px]",
            SETTINGS_ICON_TONE_CLASSNAME[resolvedIconTone],
          )}
        >
          <Icon icon={icon} size="md" />
        </span>
      ) : null}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div
          data-slot="settings-row-title"
          className={cn(
            "text-[17px] font-normal leading-[22px] tracking-normal text-foreground [overflow-wrap:anywhere]",
            tone === "destructive" && "text-destructive",
          )}
        >
          {title}
        </div>
        {description ? (
          <div
            data-slot="settings-row-description"
            className="text-[15px] leading-[20px] text-muted-foreground [overflow-wrap:anywhere]"
          >
            {description}
          </div>
        ) : null}
      </div>
    </div>
  );
  const trailingContent =
    trailing || chevron ? (
      <div
        className={cn(
          "relative z-0 flex max-w-full shrink-0 items-center justify-end self-center gap-2.5 pr-0.5 sm:pr-1",
          shouldStackTrailing &&
            "w-full min-w-0 justify-between pl-[var(--settings-row-stack-indent,2.65rem)] pt-1 sm:w-auto sm:justify-end sm:pl-0 sm:pt-0",
        )}
      >
        {trailing}
        {chevron ? (
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 text-[color:var(--app-tertiary-label)] transition-transform",
              isInteractive && "group-hover:translate-x-0.5",
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
      "transition-[border-color,box-shadow] focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0",
  );
  const primaryActionClassName = cn(
    "relative isolate min-w-0 overflow-hidden rounded-[inherit] border-0 bg-transparent px-[var(--settings-row-px)] py-[var(--settings-row-py)] text-left outline-hidden ring-0 transition-[border-color,box-shadow] [-webkit-tap-highlight-color:transparent] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  );
  const voiceProps = {
    "data-voice-control-id": voiceControlId || undefined,
    "data-voice-action-id": voiceActionId || undefined,
    "data-voice-label":
      voiceLabel || (typeof title === "string" ? title : undefined),
    "data-voice-purpose":
      voicePurpose ||
      (typeof description === "string" ? description : undefined),
  };
  const asChildContent = resolvedAsChild
    ? cloneElement(
        children as ReactElement,
        undefined,
        mainContent,
        trailingContent,
        isInteractive ? (
          <MaterialRipple
            variant="none"
            effect="fade"
            disabled={disabled}
            className="z-10"
          />
        ) : null,
      )
    : children;

  if (splitPrimaryAction) {
    return (
      <div className={rowShellClassName} data-testid={testId} data-tone={tone}>
        <div
          className={cn(
            "relative z-10 grid w-full px-[var(--settings-row-px)] py-[var(--settings-row-py)]",
            shouldStackTrailing
              ? "grid-cols-1 gap-y-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-3"
              : "grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3",
          )}
        >
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-pressed={ariaPressed}
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
            <div role="presentation" onClick={(e) => e.stopPropagation()}>
              {trailingContent}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (resolvedAsChild) {
    return (
      <div className={rowShellClassName} data-testid={testId} data-tone={tone}>
        <Comp
          {...(!resolvedAsChild
            ? { "aria-disabled": disabled || undefined }
            : {})}
          className={sharedClassName}
          {...voiceProps}
        >
          {asChildContent}
        </Comp>
      </div>
    );
  }

  return (
    <div className={rowShellClassName} data-testid={testId} data-tone={tone}>
      {isInteractive ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 z-[1] bg-transparent transition-[background-color]",
            "group-hover/settings-row:bg-foreground/[0.04] group-active/settings-row:bg-foreground/[0.065]",
          )}
        />
      ) : null}
      <Comp
        {...(!asChild && onClick
          ? {
              type: "button" as const,
              onClick,
              disabled,
              "aria-pressed": ariaPressed,
            }
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

export type AdaptiveDetailSurfaceProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leading?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  bodyClassName?: string;
  /** Shared token classes applied inside the Drawer/Dialog portal. */
  surfaceClassName?: string;
  contentClassName?: string;
  mobilePresentation?: "fullscreen" | "sheet";
  /** Direct-decision sheets may omit a redundant visual X. */
  showCloseButton?: boolean;
  desktopMaxWidthClassName?: string;
  desktopMaxWidth?: string;
};

/** The one cross-app, adaptive record-detail surface. */
export function AdaptiveDetailSurface({
  open,
  onOpenChange,
  leading,
  eyebrow,
  title,
  description,
  children,
  footer,
  bodyClassName,
  surfaceClassName,
  contentClassName,
  mobilePresentation = "fullscreen",
  showCloseButton = true,
  desktopMaxWidthClassName,
  desktopMaxWidth,
}: AdaptiveDetailSurfaceProps) {
  const isMobile = useIsMobile();
  // A query-backed selection can mount this surface before the mobile media
  // query effect has resolved. Rendering the desktop Dialog for that one
  // frame and then replacing it with the mobile Drawer leaves two portals
  // briefly visible on iOS. Wait for the client presentation decision before
  // mounting an open detail surface so every record opens through one owner.
  const [presentationReady, setPresentationReady] = useState(false);

  useEffect(() => {
    setPresentationReady(true);
  }, []);

  if (open && !presentationReady) {
    return null;
  }

  const closeButton = (
    <button
      type="button"
      aria-label="Close detail panel"
      onClick={() => onOpenChange(false)}
      className={cn(
        "group absolute right-3 top-3 z-20 isolate inline-flex h-9 w-9 items-center justify-center overflow-hidden rounded-full",
        "border border-transparent bg-[color:var(--app-card-surface-compact)] text-muted-foreground opacity-75",
        "transition-[opacity,transform,color] duration-200 hover:text-foreground hover:opacity-100 active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
    >
      <Icon icon={X} size="xs" />
      <MaterialRipple variant="none" effect="fade" className="z-10" />
    </button>
  );

  if (isMobile) {
    if (mobilePresentation === "sheet") {
      return (
        <Sheet open={open} onOpenChange={onOpenChange} modal>
          <SheetContent
            side="bottom"
            showCloseButton={showCloseButton}
            className={cn("gap-0", surfaceClassName, contentClassName)}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              (event.currentTarget as HTMLElement).focus();
            }}
          >
            <SheetHeader className="morphy-theme-content sticky top-0 z-10 border-b border-[color:var(--app-card-border-standard)] bg-[var(--activeGlassColor)] px-4 py-3 text-left backdrop-blur-[var(--blur-standard)]">
              <div className="flex min-w-0 items-center gap-3 pr-10">
                {leading ? <div className="shrink-0">{leading}</div> : null}
                <div className="min-w-0">
                  {eyebrow ? (
                    <p className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                      {eyebrow}
                    </p>
                  ) : null}
                  <SheetTitle className="truncate text-base font-semibold tracking-tight">
                    {title}
                  </SheetTitle>
                  <SheetDescription
                    className={cn(
                      "line-clamp-2 text-sm leading-5",
                      !description && "sr-only",
                    )}
                  >
                    {description ?? "Details"}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>
            <div
              className={cn(
                "bg-[color:var(--app-card-surface-default-solid)] px-3 pb-[calc(var(--app-safe-area-bottom-effective,env(safe-area-inset-bottom,0px))+1rem)] pt-3 sm:px-4 sm:pt-4",
                bodyClassName,
              )}
            >
              {children}
            </div>
            {footer ? (
              <div className="sticky bottom-0 border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-4">
                {footer}
              </div>
            ) : null}
          </SheetContent>
        </Sheet>
      );
    }

    return (
      <Drawer open={open} onOpenChange={onOpenChange} modal>
        <DrawerContent
          className={cn(
            "bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-feature)]",
            mobilePresentation === "fullscreen"
              ? "h-[100dvh] max-h-[100dvh] rounded-none border-none"
              : "max-h-[calc(85dvh-var(--kb-height,0px))] rounded-t-[var(--app-card-radius-feature)] border-t border-[color:var(--app-card-border-standard)]",
            surfaceClassName,
            contentClassName,
          )}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
        >
          <DrawerHeader className="morphy-theme-content sticky top-0 z-10 border-b border-[color:var(--app-card-border-standard)] bg-[var(--activeGlassColor)] px-4 py-3 pr-14 text-left backdrop-blur-[var(--blur-standard)] sm:px-5 sm:py-4 sm:pr-14">
            <div className="flex min-w-0 items-center gap-3">
              {leading ? <div className="shrink-0">{leading}</div> : null}
              <div className="min-w-0">
                {eyebrow ? (
                  <p className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                    {eyebrow}
                  </p>
                ) : null}
                <DrawerTitle className="truncate text-base font-semibold tracking-tight">
                  {title}
                </DrawerTitle>
                <DrawerDescription
                  className={cn(
                    "line-clamp-2 text-sm leading-5 sm:leading-6",
                    !description && "sr-only",
                  )}
                >
                  {description ?? "Details"}
                </DrawerDescription>
              </div>
            </div>
            {showCloseButton ? closeButton : null}
          </DrawerHeader>
          <div
            className={cn(
              "flex-1 overflow-y-auto bg-[color:var(--app-card-surface-default-solid)] px-3 pb-[calc(var(--app-safe-area-bottom-effective,env(safe-area-inset-bottom,0px))+2rem)] pt-3 sm:px-4 sm:pt-4",
              bodyClassName,
            )}
          >
            {children}
          </div>
          {footer ? (
            <div className="border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-4">
              {footer}
            </div>
          ) : null}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent
        data-settings-detail-panel="true"
        showCloseButton={false}
        style={desktopMaxWidth ? { maxWidth: desktopMaxWidth } : undefined}
        className={cn(
          "w-[calc(100%-1.5rem)] overflow-hidden p-0",
          desktopMaxWidthClassName || "sm:!max-w-[720px]",
          surfaceClassName,
          contentClassName,
        )}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
      >
        <DialogHeader className="morphy-theme-content sticky top-0 z-10 border-b border-[color:var(--app-card-border-standard)] bg-[var(--activeGlassColor)] px-6 py-4 pr-16 text-left backdrop-blur-[var(--blur-standard)]">
          <div className="flex min-w-0 items-center gap-3">
            {leading ? <div className="shrink-0">{leading}</div> : null}
            <div className="min-w-0">
              {eyebrow ? (
                <p className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                  {eyebrow}
                </p>
              ) : null}
              <DialogTitle className="truncate text-base font-semibold tracking-tight">
                {title}
              </DialogTitle>
              <DialogDescription
                className={cn(
                  "line-clamp-2 text-sm leading-6",
                  !description && "sr-only",
                )}
              >
                {description ?? "Details"}
              </DialogDescription>
            </div>
          </div>
          {showCloseButton ? closeButton : null}
        </DialogHeader>
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto bg-[color:var(--app-card-surface-default-solid)] px-4 pb-8 pt-4 sm:px-5 sm:pt-5",
            bodyClassName,
          )}
        >
          {children}
        </div>
        {footer ? (
          <div className="border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-6 py-4 sm:justify-end">
            {footer}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Compatibility name for existing settings callers. */
export function SettingsDetailPanel(props: AdaptiveDetailSurfaceProps) {
  return <AdaptiveDetailSurface {...props} />;
}
