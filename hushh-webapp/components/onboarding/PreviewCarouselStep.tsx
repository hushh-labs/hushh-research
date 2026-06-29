"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CarouselApi } from "@/components/ui/carousel";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/lib/morphy-ux/button";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { cn } from "@/lib/utils";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { prefersReducedMotion, getGsap } from "@/lib/morphy-ux/gsap";
import { ensureMorphyGsapReady, getMorphyEaseName } from "@/lib/morphy-ux/gsap-init";
import { getMotionCssVars } from "@/lib/morphy-ux/motion";

import { VaultPreviewCompact } from "@/components/onboarding/previews/VaultPreviewCompact";
import { WorkflowsPreviewCompact } from "@/components/onboarding/previews/WorkflowsPreviewCompact";
import { ConsentPreviewCompact } from "@/components/onboarding/previews/ConsentPreviewCompact";

type Slide = {
  title: string;
  accent: string;
  subtitle: string;
  preview: React.ReactNode;
};

export function PreviewCarouselStep({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack?: () => void;
}) {
  const slides: Slide[] = useMemo(
    () => [
      {
        title: "Unified memory,",
        accent: "only yours",
        subtitle:
          "Your memory lives in an encrypted vault. The server only ever holds ciphertext, only you hold the key.",
        preview: <VaultPreviewCompact />,
      },
      {
        title: "Unified memory,",
        accent: "every app",
        subtitle:
          "Finance, Gmail, and location all draw on one private memory, no silos.",
        preview: <WorkflowsPreviewCompact />,
      },
      {
        title: "Shared only",
        accent: "with your consent",
        subtitle:
          "Nothing is released without your yes: scoped, temporary, and audited every time.",
        preview: <ConsentPreviewCompact />,
      },
    ],
    []
  );

  const [api, setApi] = useState<CarouselApi | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [displayIndex, setDisplayIndex] = useState(0);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!api) return;
    const sync = () => setSelectedIndex(api.selectedScrollSnap());
    sync();
    api.on("select", sync);
    api.on("reInit", sync);
    return () => {
      api.off("select", sync);
      api.off("reInit", sync);
    };
  }, [api]);

  const isLast = selectedIndex === slides.length - 1;

  // Page entrance (felt when arriving on this route).
  useEffect(() => {
    const el = mountRef.current;
    if (!el || prefersReducedMotion()) return;
    let cancelled = false;
    void (async () => {
      await ensureMorphyGsapReady();
      const gsap = await getGsap();
      if (!gsap || cancelled) return;
      const { pageEnterDurationMs } = getMotionCssVars();
      gsap.fromTo(
        el,
        { opacity: 0, y: 10 },
        {
          opacity: 1,
          y: 0,
          duration: pageEnterDurationMs / 1000,
          ease: getMorphyEaseName("emphasized"),
          overwrite: "auto",
          clearProps: "opacity,transform",
        }
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Crossfade the header copy on slide change (no jump-cut).
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      setDisplayIndex(selectedIndex);
      return;
    }
    let cancelled = false;
    void (async () => {
      await ensureMorphyGsapReady();
      const gsap = await getGsap();
      if (!gsap || cancelled) return;
      const { durationsMs } = getMotionCssVars();
      gsap.to(el, {
        opacity: 0,
        y: -4,
        duration: durationsMs.sm / 1000,
        ease: getMorphyEaseName("decelerate"),
        overwrite: "auto",
        onComplete: () => {
          if (cancelled) return;
          setDisplayIndex(selectedIndex);
          gsap.fromTo(
            el,
            { opacity: 0, y: 8 },
            {
              opacity: 1,
              y: 0,
              duration: durationsMs.lg / 1000,
              ease: getMorphyEaseName("emphasized"),
              overwrite: "auto",
              clearProps: "opacity,transform",
            }
          );
        },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedIndex]);

  async function completeAndContinue() {
    await OnboardingLocalService.markMarketingSeen();
    onContinue();
  }

  async function handlePrimary() {
    if (isLast) {
      await completeAndContinue();
      return;
    }
    api?.scrollNext();
  }

  return (
    <main
      ref={mountRef}
      className="min-h-[100dvh] w-full bg-transparent"
    >
      {/* Normal-flow, centered column. Scrolls naturally if a short viewport
          can't fit it: no height-locked flex distribution, no clipping.
          Top padding clears the FIXED top controls (back button + theme pill,
          ~8px offset + 36px tall) so the title never tucks under them. */}
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col px-6 pb-[calc(24px+var(--app-safe-area-bottom-effective,0px))] pt-[calc(60px+var(--app-safe-area-top-effective,0px))]">
        {/* Top bar: back button. Fixed + offset to sit on the exact same top
            line as the lean theme pill (navbar uses the same fixed top + px-4).
            Uses the shared ShellActionSurface primitive so it stays in lockstep
            with every other top-app-bar control (size, roundness, track). */}
        {onBack ? (
          <div
            className="fixed left-0 top-0 z-50 flex px-4"
            style={{ top: "calc(max(var(--app-safe-area-top-effective), 0.5rem))" }}
          >
            <ShellActionSurface
              variant="icon"
              aria-label="Go back"
              onClick={onBack}
            >
              <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={2} />
            </ShellActionSurface>
          </div>
        ) : null}

        {/* Center block grows to fill, keeping header+card+footer balanced.
            Uses justify-start so a tall layout on a short viewport never clips
            the title at the top, it simply scrolls. */}
        <div className="flex flex-1 flex-col items-center justify-center gap-6 py-4 max-[700px]:justify-start">
          <div ref={headerRef} className="w-full text-center">
            <h2 className="text-[clamp(24px,7vw,32px)] font-medium leading-[1.1] text-[#1d1d1f] dark:text-[#f5f5f7]">
              {slides[displayIndex]?.title}{" "}
              <br />
              <span>{slides[displayIndex]?.accent}</span>
            </h2>
            <p className="mx-auto mt-3 max-w-[20rem] text-[15px] leading-snug text-[rgba(0,0,0,0.56)] dark:text-[rgba(245,245,247,0.60)]">
              {slides[displayIndex]?.subtitle}
            </p>
          </div>

          {/* Gold-standard shadcn carousel: w-full + max-w, items size to content,
              arrows as children. Embla's viewport is overflow-hidden, so the card's
              soft drop shadow must live INSIDE the padded area or it gets clipped
              into a hard rectangular seam. Generous symmetric padding (with extra
              room below for the downward shadow) keeps the elevation soft on every
              edge. */}
          <Carousel
            setApi={setApi}
            opts={{ align: "center" }}
            className="w-full max-w-sm"
            aria-label="What One can do"
          >
            <CarouselContent>
              {slides.map((slide, idx) => (
                <CarouselItem
                  key={idx}
                  aria-label={`Slide ${idx + 1} of ${slides.length}`}
                  aria-current={idx === selectedIndex ? "step" : undefined}
                >
                  <div className="px-5 pb-7 pt-4">{slide.preview}</div>
                </CarouselItem>
              ))}
            </CarouselContent>
            {/* Desktop arrows; auto-disable at the ends. Hidden on mobile (swipe). */}
            <CarouselPrevious className="hidden sm:flex" />
            <CarouselNext className="hidden sm:flex" />
          </Carousel>
        </div>

        {/* Footer pinned to the bottom of the flow. */}
        <div className="flex shrink-0 flex-col items-center gap-3">
          <Dots count={slides.length} activeIndex={selectedIndex} />
          <Button
            size="lg"
            fullWidth
            className="h-[52px] w-full max-w-[22rem] rounded-full bg-[#d4a574] text-[17px] font-medium !text-white shadow-none hover:opacity-90 dark:!text-white"
            onClick={handlePrimary}
            showRipple
          >
            {isLast ? "Sign in" : "Next"}
          </Button>
          <button
            type="button"
            onClick={completeAndContinue}
            className="min-h-10 px-4 text-[15px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Skip
          </button>
        </div>
      </div>
    </main>
  );
}

function Dots(props: { count: number; activeIndex: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {`Slide ${props.activeIndex + 1} of ${props.count}`}
      </span>
      {Array.from({ length: props.count }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-[7px] rounded-full transition-[width,background-color]",
            i === props.activeIndex
              ? "w-6 bg-[#d4a574]"
              : "w-[7px] bg-black/10 dark:bg-white/15"
          )}
          aria-hidden
        />
      ))}
    </div>
  );
}
