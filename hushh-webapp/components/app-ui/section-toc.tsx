"use client";

// components/app-ui/section-toc.tsx
// Shared "jump to section" table-of-contents: a sticky rail on desktop, a
// bottom Drawer sheet (vaul, drag-to-dismiss) opened from a floating FAB on
// mobile. Extracted from components/developers/developer-docs-hub.tsx so
// long-form pages (Developers, the PCHP spec, long blog posts) share one
// TOC implementation instead of each hand-rolling its own sidebar/nav.

import { Menu } from "lucide-react";

import { useIsMobile } from "@/hooks/use-mobile";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { RowDescription } from "@/components/app-ui/typography";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

export type SectionTocEntry = {
  id: string;
  label: string;
  summary?: string;
};

function SectionTocRows({
  entries,
  onSelectSection,
  compact = false,
  showSummaries = true,
}: {
  entries: SectionTocEntry[];
  onSelectSection: (sectionId: string) => void;
  compact?: boolean;
  showSummaries?: boolean;
}) {
  return (
    <>
      {entries.map((entry) => (
        <SettingsRow
          key={entry.id}
          title={entry.label}
          description={
            showSummaries && entry.summary ? (
              <span className={compact ? "line-clamp-1" : undefined}>
                {entry.summary}
              </span>
            ) : undefined
          }
          chevron
          density={compact ? "compact" : "comfortable"}
          className={compact ? "px-3 sm:px-3.5" : undefined}
          onClick={() => onSelectSection(entry.id)}
        />
      ))}
    </>
  );
}

/** Desktop-only sticky rail, hidden below the lg breakpoint. */
export function SectionTocRail({
  entries,
  onSelectSection,
  title = "Sections",
  description = "Jump anywhere on the page.",
}: {
  entries: SectionTocEntry[];
  onSelectSection: (sectionId: string) => void;
  title?: string;
  description?: string;
}) {
  return (
    <aside className="hidden lg:sticky lg:top-[calc(var(--top-shell-reserved-height)+1rem)] lg:block lg:self-start">
      <nav
        aria-label={title}
        className="overflow-hidden border-y border-border/60 bg-background/45"
      >
        <header className="space-y-1 px-3 py-3 sm:px-4">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <RowDescription>{description}</RowDescription>
        </header>
        <ScrollArea className="max-h-[calc(100dvh-var(--top-shell-reserved-height)-9rem)] border-t border-border/60">
          <div className="divide-y divide-border/60">
            <SectionTocRows
              entries={entries}
              onSelectSection={onSelectSection}
              compact
              showSummaries={false}
            />
          </div>
        </ScrollArea>
      </nav>
    </aside>
  );
}

/** Mobile-only floating action button opening a bottom Drawer sheet. */
export function SectionTocMobileFab({
  entries,
  open,
  onOpenChange,
  onSelectSection,
  fabLabel = "Sections",
  drawerTitle = "Jump to a section",
  drawerDescription = "Move through the page without scrolling.",
}: {
  entries: SectionTocEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSection: (sectionId: string) => void;
  fabLabel?: string;
  drawerTitle?: string;
  drawerDescription?: string;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <div
        className="fixed right-4 z-[160] md:hidden transition-all duration-300"
        style={{ 
          bottom: "calc(max(var(--app-safe-area-bottom-effective), 0.75rem) + var(--app-scroll-bottom-pad, 0px) + 0.5rem)" 
        }}
      >
        <MorphyButton
          variant="blue-gradient"
          effect="fill"
          size="sm"
          className="rounded-full px-4 shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
          onClick={() => onOpenChange(true)}
        >
          <Menu className="size-4" />
          {fabLabel}
        </MorphyButton>
      </div>
      <DrawerContent className="max-h-[78vh] rounded-t-[28px] border-t border-border/80 bg-background/98 md:hidden">
        <DrawerHeader className="border-b border-border/80 bg-background/96 px-4 py-4 text-left backdrop-blur-xl">
          <DrawerTitle>{drawerTitle}</DrawerTitle>
          <DrawerDescription>{drawerDescription}</DrawerDescription>
        </DrawerHeader>
        <div className="max-h-[56vh] overflow-y-auto overscroll-contain px-4 py-4">
          <SettingsGroup embedded className="space-y-0">
            <SectionTocRows
              entries={entries}
              onSelectSection={(sectionId) => {
                onSelectSection(sectionId);
                onOpenChange(false);
              }}
            />
          </SettingsGroup>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * Combined TOC: renders the desktop rail OR the mobile FAB+Drawer, so a
 * caller can drop one component in a layout's sidebar slot and get the
 * correct affordance for the current viewport. The mobile open/close state
 * is owned internally; pass a stable `onSelectSection` for scroll/nav logic.
 */
export function SectionToc({
  entries,
  onSelectSection,
  railTitle,
  railDescription,
  fabLabel,
  drawerTitle,
  drawerDescription,
  mobileOpen,
  onMobileOpenChange,
}: {
  entries: SectionTocEntry[];
  onSelectSection: (sectionId: string) => void;
  railTitle?: string;
  railDescription?: string;
  fabLabel?: string;
  drawerTitle?: string;
  drawerDescription?: string;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <SectionTocMobileFab
        entries={entries}
        open={mobileOpen}
        onOpenChange={onMobileOpenChange}
        onSelectSection={onSelectSection}
        fabLabel={fabLabel}
        drawerTitle={drawerTitle}
        drawerDescription={drawerDescription}
      />
    );
  }

  return (
    <SectionTocRail
      entries={entries}
      onSelectSection={onSelectSection}
      title={railTitle}
      description={railDescription}
    />
  );
}
