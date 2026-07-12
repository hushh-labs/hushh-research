"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { ProseMarkdown } from "@/components/research/prose-markdown";
import { ResearchSubNav } from "@/components/research/research-sub-nav";
import { PCHP_SPEC_SECTIONS, PCHP_SPEC_META } from "@/lib/research/pchp-spec";
import {
  SUMMER_HERO_WASH,
  summerColorByIndex,
} from "@/lib/research/summer-theme";
import { cn } from "@/lib/utils";

export function PchpSpecView() {
  const [activeId, setActiveId] = useState(
    PCHP_SPEC_SECTIONS[0]?.id ?? "overview"
  );
  const activeIndex = Math.max(
    0,
    PCHP_SPEC_SECTIONS.findIndex((s) => s.id === activeId)
  );
  const active = PCHP_SPEC_SECTIONS[activeIndex] ?? PCHP_SPEC_SECTIONS[0];
  if (!active) return null;
  const activeColor = summerColorByIndex(activeIndex);

  return (
    <AppPageShell width="standard" className="py-6 sm:py-10">
      <AppPageHeaderRegion>
        <div className="mb-5">
          <ResearchSubNav />
        </div>
        <div className="relative overflow-hidden rounded-[var(--app-card-radius-feature)] border border-border/60 px-5 py-6 sm:px-7 sm:py-8">
          <div className={SUMMER_HERO_WASH} />
          <div className="flex items-start gap-4">
            <div className="flex w-12 shrink-0 items-center justify-center rounded-[var(--app-card-radius-feature)] border border-sky-500/20 bg-white/60 p-3 text-sky-700 shadow-sm dark:bg-white/10 dark:text-sky-200">
              <FileText className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700 dark:text-sky-300">
                Specification · {PCHP_SPEC_META.version}
              </p>
              <h1 className="mt-1 bg-gradient-to-r from-sky-600 via-violet-600 to-orange-500 bg-clip-text text-[27px] font-semibold leading-[1.1] tracking-tight text-transparent sm:text-[33px] dark:from-sky-300 dark:via-fuchsia-300 dark:to-amber-300">
                Personal Consent Handshake Protocol
              </h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {PCHP_SPEC_META.status} · updated {PCHP_SPEC_META.updated} · CC0 +
                Apache-2.0
              </p>
            </div>
          </div>
        </div>
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mt-8">
        <div className="flex flex-col gap-8 lg:flex-row">
          {/* Section rail */}
          <aside className="lg:w-64 lg:shrink-0">
            <div className="lg:sticky lg:top-6">
              <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Contents
              </p>
              <nav className="flex flex-col gap-0.5">
                {PCHP_SPEC_SECTIONS.map((section, index) => {
                  const isActive = section.id === activeId;
                  const color = summerColorByIndex(index);
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => {
                        setActiveId(section.id);
                        if (typeof window !== "undefined") {
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }
                      }}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
                        isActive
                          ? cn(color.activePill, "font-medium")
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      )}
                      aria-current={isActive ? "true" : undefined}
                    >
                      <span
                        className={cn(
                          "h-2 w-2 shrink-0 rounded-full",
                          color.dot,
                          isActive ? "opacity-100" : "opacity-45"
                        )}
                      />
                      {section.label}
                    </button>
                  );
                })}
              </nav>
            </div>
          </aside>

          {/* Section body */}
          <article className="min-w-0 flex-1">
            <div className="mb-5 border-b border-border/60 pb-4">
              <p
                className={cn(
                  "text-xs font-semibold uppercase tracking-[0.16em]",
                  activeColor.text
                )}
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
