"use client";

import { useMemo, useState } from "react";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SectionToc, type SectionTocEntry } from "@/components/app-ui/section-toc";
import { ProseMarkdown } from "@/components/research/prose-markdown";
import { PCHP_SPEC_SECTIONS, PCHP_SPEC_META } from "@/lib/research/pchp-spec";

export function PchpSpecView() {
  const [activeId, setActiveId] = useState(
    PCHP_SPEC_SECTIONS[0]?.id ?? "overview"
  );
  const [tocOpen, setTocOpen] = useState(false);
  const activeIndex = Math.max(
    0,
    PCHP_SPEC_SECTIONS.findIndex((s) => s.id === activeId)
  );
  const active = PCHP_SPEC_SECTIONS[activeIndex] ?? PCHP_SPEC_SECTIONS[0];

  const tocEntries = useMemo<SectionTocEntry[]>(
    () =>
      PCHP_SPEC_SECTIONS.map((section) => ({
        id: section.id,
        label: section.label,
        summary: section.summary,
      })),
    []
  );

  const handleSelectSection = (sectionId: string) => {
    setActiveId(sectionId);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  if (!active) return null;

  return (
    <AppPageShell width="standard" className="pb-8 pt-0 sm:pb-10">
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow={`PCHP · ${PCHP_SPEC_META.version}`}
          title="Personal Consent Handshake Protocol"
          description={`${PCHP_SPEC_META.status} · updated ${PCHP_SPEC_META.updated} · CC0 + Apache-2.0`}
          descriptionFullWidth
          accent="research"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mt-5">
        <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[17rem_minmax(0,1fr)]">
          <SectionToc
            entries={tocEntries}
            onSelectSection={handleSelectSection}
            railTitle="Contents"
            railDescription="Jump to any part of the spec."
            fabLabel="Contents"
            drawerTitle="Jump to a section"
            drawerDescription="Move through the spec without scrolling."
            mobileOpen={tocOpen}
            onMobileOpenChange={setTocOpen}
          />

          {/* Section body */}
          <article className="min-w-0">
            <div className="mb-5 border-b border-border/60 pb-4">
              <p
              className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong"
              >
                {active.eyebrow}
              </p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
                {active.label}
              </h2>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {active.summary}
              </p>
            </div>
            <ProseMarkdown>{active.body}</ProseMarkdown>

            <div className="mt-10 flex items-center justify-between border-t border-border/60 pt-5">
              <PagerButton
                sections={PCHP_SPEC_SECTIONS}
                activeId={activeId}
                direction="prev"
                onSelect={setActiveId}
              />
              <PagerButton
                sections={PCHP_SPEC_SECTIONS}
                activeId={activeId}
                direction="next"
                onSelect={setActiveId}
              />
            </div>
          </article>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

function PagerButton({
  sections,
  activeId,
  direction,
  onSelect,
}: {
  sections: typeof PCHP_SPEC_SECTIONS;
  activeId: string;
  direction: "prev" | "next";
  onSelect: (id: string) => void;
}) {
  const index = sections.findIndex((s) => s.id === activeId);
  const target =
    direction === "prev" ? sections[index - 1] : sections[index + 1];
  if (!target) return <span />;
  return (
    <button
      type="button"
      onClick={() => {
        onSelect(target.id);
        if (typeof window !== "undefined") {
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      }}
      className="flex flex-col text-sm text-muted-foreground transition-colors hover:text-foreground"
      style={{ textAlign: direction === "prev" ? "left" : "right" }}
    >
      <span className="text-xs uppercase tracking-[0.12em]">
        {direction === "prev" ? "Previous" : "Next"}
      </span>
      <span className="font-medium text-foreground">{target.label}</span>
    </button>
  );
}
