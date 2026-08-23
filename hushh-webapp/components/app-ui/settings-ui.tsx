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
import {
  CardTitle,
  PageSubtitle,
  RowDescription,
  RowLabel,
  SectionLabel,
  TrailingAction,
  TrailingValue,
} from "@/components/app-ui/typography";
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
    "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)] dark:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-bright)]",
  blue:
    "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)] dark:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-bright)]",
  purple:
    "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)] dark:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-bright)]",
  green:
    "bg-[rgba(52,199,89,0.12)] text-[#34C759] dark:bg-[rgba(48,209,88,0.20)] dark:text-[#30D158]",
  orange:
    "bg-[rgba(255,159,10,0.12)] text-[#FF9F0A] dark:bg-[rgba(255,159,10,0.20)] dark:text-[#FFD60A]",
  red:
    "bg-[rgba(255,59,48,0.12)] text-[#FF3B30] dark:bg-[rgba(255,69,58,0.20)] dark:text-[#FF6961]",
  // People, circles and private sharing. Added because the tone vocabulary was
  // smaller than the semantics: `accent`, `blue` and `purple` are byte-identical
  // above, so "these are PEOPLE" had no colour of its own and every row that
  // meant it rendered as the same action blue as "Share location".
  //
  // Reads --app-indigo rather than carrying its own literals: the value already
  // existed a second time in globals.css (the profile screens' icon-tone
  // override), so a hardcoded pair here made one colour live in two files with
  // nothing binding them. Same 12%/20% tile recipe as the rest, and the token
  // brightens for dark the way --app-warning and --app-destructive do.
  indigo:
    "bg-[color-mix(in_srgb,var(--app-indigo)_12%,transparent)] text-[color:var(--app-indigo)] dark:bg-[color-mix(in_srgb,var(--app-indigo)_20%,transparent)] dark:text-[color:var(--app-indigo)]",
  gray:
    "bg-[#E5E5EA] text-[#6E6E73] dark:bg-[rgba(142,142,147,0.28)] dark:text-[#D1D1D6]",
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
      data-ui-role="grouped-card"
      data-slot="settings-group-shell"
      className={cn(
        // Inset settings groups use the compact card radius and flat grouped
        // Apple surfaces; separators inside the card carry the structure.
        "relative isolate [--settings-group-radius:var(--app-card-radius-standard,24px)] overflow-hidden rounded-[var(--settings-group-radius)]",
        "bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)] ring-0",
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
        "w-full",
        className,
      )}
      data-testid={testId}
    >
      {eyebrow || title || description ? (
        <div className="mb-2 mt-7 space-y-[var(--settings-heading-stack-gap)] px-[6px]">
          {eyebrow || title ? (
            <SectionLabel
              data-slot="settings-group-heading"
              role="heading"
              aria-level={embedded ? 3 : 2}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-pretty [overflow-wrap:anywhere]"
            >
              {eyebrow ? (
                <span>
                  {eyebrow}
                </span>
              ) : null}
              {title ? <span>{title}</span> : null}
            </SectionLabel>
          ) : null}
          {description ? (
            <RowDescription className="max-w-2xl [overflow-wrap:anywhere]">
              {description}
            </RowDescription>
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
  ariaLabel,
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
  /**
   * Explicit accessible name for a row that is itself the control.
   *
   * A selectable row's button otherwise takes its name from the title, so
   * it announces "Trusted B" -- the subject, with no verb. Callers that
   * turn a whole row into a select/toggle affordance pass the action here
   * ("Select Trusted B for private sharing") so the control still says
   * what it does. Omit it and the title-derived name is used, unchanged.
   */
  ariaLabel?: string;
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
      ? resolvedDensity === "compact"
        ? "group-data-[inset-separators=true]/settings-list:after:left-[58px] sm:group-data-[inset-separators=true]/settings-list:after:left-[58px]"
        : "group-data-[inset-separators=true]/settings-list:after:left-[62px] sm:group-data-[inset-separators=true]/settings-list:after:left-[62px]"
      : "group-data-[inset-separators=true]/settings-list:after:left-0";
  const rowShellClassName = cn(
    "group/settings-row relative isolate overflow-hidden bg-transparent",
    resolvedDensity === "compact" && "[--settings-row-py:10px]",
    // iOS-style separator — active only inside SettingsGroup with
    // separatorInset and hidden on the final row. Its start is derived from
    // whether this row actually has a leading visual.
    "group-data-[inset-separators=true]/settings-list:after:pointer-events-none group-data-[inset-separators=true]/settings-list:after:absolute group-data-[inset-separators=true]/settings-list:after:bottom-0 group-data-[inset-separators=true]/settings-list:after:right-4 group-data-[inset-separators=true]/settings-list:after:h-px group-data-[inset-separators=true]/settings-list:after:bg-[color:var(--app-separator)] group-data-[inset-separators=true]/settings-list:after:content-[''] last:after:hidden",
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
          data-ui-role="settings-icon"
          data-slot="settings-row-icon"
          data-icon-tone={resolvedIconTone}
          className={cn(
            // Keep settings icons as iOS-style rounded-square utility wells.
            // Agent artwork continues to use AgentSectionIcon, which owns the
            // larger launcher/menu geometry separately.
            "inline-flex shrink-0 items-center justify-center self-center",
            resolvedDensity === "compact"
              ? "h-7 w-7 rounded-[7px]"
              : "h-[34px] w-[34px] rounded-[10px] sm:h-[34px] sm:w-[34px] sm:rounded-[10px]",
            SETTINGS_ICON_TONE_CLASSNAME[resolvedIconTone],
          )}
        >
          <Icon icon={icon} size={resolvedDensity === "compact" ? 16 : 17} />
        </span>
      ) : null}
      <div className="min-w-0 flex-1 space-y-0.5">
        <RowLabel
          as="div"
          data-slot="settings-row-title"
          className={cn(
            "[overflow-wrap:anywhere]",
            tone === "destructive" && "text-destructive",
          )}
        >
          {title}
        </RowLabel>
        {description ? (
          <RowDescription
            as="div"
            data-slot="settings-row-description"
            className="[overflow-wrap:anywhere]"
          >
            {description}
          </RowDescription>
        ) : null}
      </div>
    </div>
  );
  const renderedTrailing =
    typeof trailing === "string" || typeof trailing === "number" ? (
      <TrailingValue>{trailing}</TrailingValue>
    ) : (
      trailing
    );
  const trailingContent =
    renderedTrailing || chevron ? (
      <div
        className={cn(
          "relative z-0 flex max-w-full shrink-0 items-center justify-end self-center gap-2.5 pr-0.5 sm:pr-1",
          shouldStackTrailing &&
            "w-full min-w-0 justify-between pl-[var(--settings-row-stack-indent,2.65rem)] pt-1 sm:w-auto sm:justify-end sm:pl-0 sm:pt-0",
        )}
      >
        {renderedTrailing}
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
    resolvedDensity === "compact" ? "min-h-[56px]" : "min-h-[60px]",
    shouldStackTrailing
      ? "grid-cols-1 gap-y-[var(--settings-row-stack-gap)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-[var(--settings-row-gap)] sm:gap-y-0"
      : "grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[var(--settings-row-gap)]",
    isInteractive &&
      "transition-[border-color,box-shadow] focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0",
  );
  const primaryActionClassName = cn(
    "relative isolate min-w-0 overflow-hidden border-0 bg-transparent px-[var(--settings-row-px)] py-[var(--settings-row-py)] text-left outline-hidden ring-0 transition-[background-color,border-color,box-shadow] [-webkit-tap-highlight-color:transparent] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    "rounded-[inherit] [@media(hover:hover)]:rounded-xl",
    "[@media(hover:hover)]:hover:bg-foreground/[0.04] active:bg-foreground/[0.065]",
    resolvedDensity === "compact" ? "min-h-[56px]" : "min-h-[60px]",
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
            aria-label={ariaLabel}
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
            <div
              role="presentation"
              onClick={(e) => {
                if (onClick) onClick();
                else e.stopPropagation();
              }}
              className={onClick ? "cursor-pointer" : undefined}
            >
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
            "[@media(hover:hover)]:group-hover/settings-row:bg-foreground/[0.04] group-active/settings-row:bg-foreground/[0.065]",
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
              "aria-label": ariaLabel,
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
            <SheetHeader className="morphy-theme-content sticky top-0 z-10 border-b border-[color:var(--app-card-border-standard)] bg-[var(--activeGlassColor)] px-4 pt-8 pb-3 text-left backdrop-blur-[var(--blur-standard)]">
              <div className="flex min-w-0 items-center gap-3 pr-10 text-left">
                {leading ? <div className="shrink-0">{leading}</div> : null}
                <div className="min-w-0 text-left">
                  {eyebrow ? (
                    <SectionLabel as="p">
                      {eyebrow}
                    </SectionLabel>
                  ) : null}
                  <SheetTitle className="ui-text-navigation-title truncate">
                    {title}
                  </SheetTitle>
                  <SheetDescription
                    className={cn(
                      "ui-text-row-description line-clamp-2",
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
          <DrawerHeader className="morphy-theme-content sticky top-0 z-10 border-b border-[color:var(--app-card-border-standard)] bg-[var(--activeGlassColor)] px-4 pt-8 pb-3 pr-14 text-left backdrop-blur-[var(--blur-standard)] sm:px-5 sm:pt-6 sm:pb-4 sm:pr-14">
            <div className="flex min-w-0 items-center gap-3 text-left">
              {leading ? <div className="shrink-0">{leading}</div> : null}
              <div className="min-w-0 text-left">
                {eyebrow ? (
                  <SectionLabel as="p">
                    {eyebrow}
                  </SectionLabel>
                ) : null}
                <DrawerTitle className="ui-text-navigation-title truncate">
                  {title}
                </DrawerTitle>
                <DrawerDescription
                  className={cn(
                    "ui-text-row-description line-clamp-2",
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
          <div className="flex min-w-0 items-center gap-3 text-left">
            {leading ? <div className="shrink-0">{leading}</div> : null}
            <div className="min-w-0 text-left">
              {eyebrow ? (
                <SectionLabel as="p">
                  {eyebrow}
                </SectionLabel>
              ) : null}
              <DialogTitle className="ui-text-navigation-title truncate">
                {title}
              </DialogTitle>
              <DialogDescription
                className={cn(
                  "ui-text-row-description line-clamp-2",
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

export {
  CardTitle,
  PageSubtitle,
  RowDescription,
  RowLabel,
  SectionLabel,
  TrailingAction,
  TrailingValue,
};
