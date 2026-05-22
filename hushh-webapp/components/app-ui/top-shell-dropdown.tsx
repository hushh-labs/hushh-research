"use client";

import * as React from "react";

import { DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export const TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME =
  "w-[360px] max-w-[calc(100vw-1rem)] max-md:w-[calc(100vw-1.5rem)] max-md:min-w-[calc(100vw-1.5rem)] max-md:max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-[22px] border border-border/60 bg-background/88 p-0 shadow-[0_28px_72px_-42px_rgba(15,23,42,0.44)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/76";

export const TOP_SHELL_DROPDOWN_COLLISION_PADDING = 12;

export const TOP_SHELL_DROPDOWN_HEADER_CLASSNAME =
  "border-b border-border/50 px-4 py-3";

export const TOP_SHELL_DROPDOWN_BODY_CLASSNAME =
  "max-h-[420px] overflow-y-auto px-3 py-3";

export const TOP_SHELL_DROPDOWN_FOOTER_CLASSNAME =
  "border-t border-border/50 px-3 py-3";

type TopShellDropdownContentProps = React.ComponentProps<
  typeof DropdownMenuContent
>;

function openDropdownTrigger() {
  const triggers = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-slot="dropdown-menu-trigger"][data-state="open"]',
    ),
  );

  return triggers.find((trigger) => {
    const rect = trigger.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function centeredMobileAlignOffset(
  trigger: HTMLElement,
  align: TopShellDropdownContentProps["align"],
) {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const gutter = TOP_SHELL_DROPDOWN_COLLISION_PADDING;
  const panelWidth = Math.max(0, viewportWidth - gutter * 2);
  const desiredX = (viewportWidth - panelWidth) / 2;
  const rect = trigger.getBoundingClientRect();

  let baseX = rect.right - panelWidth;
  if (align === "start") {
    baseX = rect.left;
  } else if (align === "center") {
    baseX = rect.left + rect.width / 2 - panelWidth / 2;
  }

  return desiredX - baseX;
}

export function TopShellDropdownContent({
  align = "end",
  alignOffset,
  className,
  collisionPadding = TOP_SHELL_DROPDOWN_COLLISION_PADDING,
  ...props
}: TopShellDropdownContentProps) {
  const isMobile = useIsMobile();
  const [mobileAlignOffset, setMobileAlignOffset] = React.useState<
    number | undefined
  >(undefined);

  React.useLayoutEffect(() => {
    if (!isMobile) {
      setMobileAlignOffset(undefined);
      return;
    }

    const update = () => {
      const trigger = openDropdownTrigger();
      setMobileAlignOffset(
        trigger ? centeredMobileAlignOffset(trigger, align) : undefined,
      );
    };

    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, [align, isMobile]);

  return (
    <DropdownMenuContent
      align={align}
      alignOffset={isMobile ? mobileAlignOffset : alignOffset}
      collisionPadding={collisionPadding}
      className={cn(TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME, className)}
      {...props}
    />
  );
}
