"use client";

import type { ReactNode } from "react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";

/**
 * Compatibility adapter for existing Kai and Location callers. The actual
 * portal, header, body, footer, keyboard, and close behavior live in the one
 * app-wide AdaptiveDetailSurface.
 */
export function KaiControlSurface({
  open,
  onOpenChange,
  leading,
  eyebrow,
  title,
  description,
  children,
  footer,
  bodyClassName,
  contentClassName,
  surfaceClassName,
  showMobileCloseButton,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leading?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  bodyClassName?: string;
  contentClassName?: string;
  surfaceClassName?: string;
  showMobileCloseButton?: boolean;
}) {
  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={onOpenChange}
      leading={leading}
      eyebrow={eyebrow}
      title={title}
      description={description}
      footer={footer}
      bodyClassName={bodyClassName}
      contentClassName={contentClassName}
      surfaceClassName={surfaceClassName}
      showMobileCloseButton={showMobileCloseButton}
      mobilePresentation="sheet"
      desktopMaxWidthClassName="sm:!max-w-[min(42rem,calc(100vw-4.5rem))] lg:!max-w-[min(46rem,calc(100vw-8rem))]"
    >
      {children}
    </AdaptiveDetailSurface>
  );
}
