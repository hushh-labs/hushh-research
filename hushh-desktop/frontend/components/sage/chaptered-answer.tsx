"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { SageMarkdown } from "@/components/sage/sage-markdown";
import { cn } from "@/lib/utils";

type Chapter = { title: string; body: string };

const WORDS_PER_MINUTE = 200;
// Only a top-level "## " heading counts as a chapter break -- a "### " stays
// inside the current chapter as a sub-heading (this mirrors what the
// thorough/exhaustive length-tier prompts in pkm_highlight.py are actually
// instructed to produce: "## Chapter Title" per chapter, "### " only for a
// finer split within one).
const CHAPTER_HEADING_RE = /^##\s+(.*)$/;

function parseChapters(text: string): { intro: string; chapters: Chapter[] } {
  const lines = text.split("\n");
  const introLines: string[] = [];
  const chapters: Chapter[] = [];
  let current: Chapter | null = null;

  for (const line of lines) {
    const match = line.match(CHAPTER_HEADING_RE);
    if (match) {
      if (current) chapters.push(current);
      current = { title: (match[1] ?? "").trim(), body: "" };
    } else if (current) {
      current.body += `${line}\n`;
    } else {
      introLines.push(line);
    }
  }
  if (current) chapters.push(current);

  return { intro: introLines.join("\n").trim(), chapters };
}

function estimateReadMinutes(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

/**
 * Long deep-mode answers (the "thorough"/"exhaustive" length tiers, up to
 * ~20k characters) read as one intimidating wall of text as plain flowing
 * markdown. Once the model's own "## " headings give it real chapter
 * structure, this renders it as a proper chaptered document instead: a
 * jump-to nav, one chapter open at a time, an estimated read time -- a
 * reader can scan the shape of the answer before committing to it.
 *
 * Answers with fewer than 2 "## " headings (short/standard-tier answers,
 * or anything the model didn't structure) render as plain flowing
 * markdown -- chapter chrome would be pure overhead on a few paragraphs.
 */
export function ChapteredAnswer({ text }: { text: string }) {
  const { intro, chapters } = useMemo(() => parseChapters(text), [text]);
  const [openIndex, setOpenIndex] = useState(0);
  const [flatView, setFlatView] = useState(false);

  if (chapters.length < 2) {
    return <SageMarkdown text={text} />;
  }

  if (flatView) {
    return (
      <div className="min-w-0">
        <div className="mb-1.5 flex justify-end">
          <button
            type="button"
            onClick={() => setFlatView(false)}
            className="text-[11px] font-medium text-violet-700 hover:underline dark:text-violet-300"
          >
            View as chapters
          </button>
        </div>
        <SageMarkdown text={text} />
      </div>
    );
  }

  const totalMinutes = estimateReadMinutes(text);

  return (
    <div className="min-w-0">
      {intro ? <SageMarkdown text={intro} /> : null}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {chapters.length} chapters · ~{totalMinutes} min read
        </p>
        <button
          type="button"
          onClick={() => setFlatView(true)}
          className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground hover:underline"
        >
          View as one page
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {chapters.map((chapter, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setOpenIndex(index)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-left text-xs font-medium transition-colors",
              openIndex === index
                ? "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300"
                : "border-border/60 bg-card text-muted-foreground hover:border-violet-500/40 hover:text-foreground",
            )}
          >
            {index + 1}. {chapter.title}
          </button>
        ))}
      </div>

      <div className="mt-2.5 space-y-1.5">
        {chapters.map((chapter, index) => {
          const isOpen = openIndex === index;
          return (
            <div key={index} className="overflow-hidden rounded-lg border border-border/50">
              <button
                type="button"
                onClick={() => setOpenIndex((current) => (current === index ? -1 : index))}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-semibold text-foreground"
                aria-expanded={isOpen}
              >
                <span className="min-w-0">
                  {index + 1}. {chapter.title}
                </span>
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
                    isOpen && "rotate-180",
                  )}
                  aria-hidden
                />
              </button>
              {isOpen ? (
                <div className="border-t border-border/50 px-3 py-2.5">
                  <SageMarkdown text={chapter.body} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
