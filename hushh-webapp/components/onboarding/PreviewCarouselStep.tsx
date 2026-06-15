"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CarouselApi } from "@/components/ui/carousel";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
} from "@/components/ui/carousel";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { prefersReducedMotion, getGsap } from "@/lib/morphy-ux/gsap";
import { ensureMorphyGsapReady, getMorphyEaseName } from "@/lib/morphy-ux/gsap-init";
import { getMotionCssVars } from "@/lib/morphy-ux/motion";
import { KAI_EXPERIENCE_CONTRACT } from "@/lib/kai/experience-contract";

import { KycPreviewCompact } from "@/components/onboarding/previews/KycPreviewCompact";
import { PortfolioPreviewCompact } from "@/components/onboarding/previews/PortfolioPreviewCompact";
import { DecisionPreviewCompact } from "@/components/onboarding/previews/DecisionPreviewCompact";

type Slide = {
  title: string;
  accent: string;
  subtitle: string;
  preview: React.ReactNode;
};

export function PreviewCarouselStep({ onContinue }: { onContinue: () => void }) {
  const slides: Slide[] = useMemo(
    () => [
      {
        title: "Verified in",
        accent: "minutes",
        subtitle: "Your identity, confirmed securely.",
        preview: <KycPreviewCompact />,
      },
      {
        title: KAI_EXPERIENCE_CONTRACT.portfolioClarity.carouselTitle,
        accent: KAI_EXPERIENCE_CONTRACT.portfolioClarity.carouselAccent,
        subtitle: "Value and today's movers, always up to date.",
        preview: <PortfolioPreviewCompact />,
      },
      {
        title: KAI_EXPERIENCE_CONTRACT.decisionConviction.carouselTitle,
        accent: KAI_EXPERIENCE_CONTRACT.decisionConviction.carouselAccent,
        subtitle: "Clear calls, the moment they matter.",
        preview: <DecisionPreviewCompact />,
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

    const sync = () => {
      setSelectedIndex(api.selectedScrollSnap());
    };
    sync();
    api.on("select", sync);
    api.on("reInit", sync);

    return () => {
      api.off("select", sync);
      api.off("reInit", sync);
    };
  }, [api]);

  const isLast = selectedIndex === slides.length - 1;

  // Step entrance animation: this is what you feel when clicking "Get Started"
  // and transitioning from Step 1 -> Step 2 without a route change.
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    if (prefersReducedMotion()) return;

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

  // Animate header text changes to avoid a jump-cut when the slide index changes.
  // We fade out the old copy, swap the index, then fade in.
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

  function handleBack() {
    api?.scrollPrev();
  }

  return (
    <main
      ref={mountRef}
      className={cn(
        "min-h-[100dvh] w-full bg-transparent flex flex-col overflow-x-hidden"
      )}
    >
      <div className="w-full min-h-[100dvh] px-4 pt-[calc(16px+var(--app-safe-area-top-effective,0px))] pb-[var(--app-screen-footer-pad)]">
        <div className="relative mx-auto flex h-full w-full flex-col">
          <div className="z-10 flex h-10 items-center justify-between px-0 sm:px-1">
            <button
              type="button"
              aria-label="Back"
              aria-hidden={selectedIndex === 0}
              tabIndex={selectedIndex > 0 ? 0 : -1}
              className={cn(
                "grid h-9 w-9 place-items-center rounded-full border border-black/10 bg-[#f5f5f7] text-[#1d1d1f] transition-[opacity,transform,color,background-color] active:scale-90 dark:border-white/10 dark:bg-white/10 dark:text-[#f5f5f7]",
                selectedIndex > 0
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none opacity-0"
              )}
              onClick={handleBack}
            >
              <ChevronLeft className="h-[17px] w-[17px]" strokeWidth={2.2} />
            </button>
            <button
              type="button"
              className="min-h-10 rounded-full px-4 text-[15px] font-medium tracking-normal text-muted-foreground transition-colors hover:text-foreground"
              onClick={completeAndContinue}
            >
              Skip
            </button>
          </div>

          <div
            ref={headerRef}
            className={cn(
              "w-full mx-auto text-center flex flex-col justify-end gap-2",
              // Keep copy + spacing responsive without clipping on larger screens.
              "min-h-[clamp(132px,18vh,190px)] pt-5",
              "sm:max-w-lg"
            )}
          >
            <h2 className="text-[32px] font-medium tracking-normal leading-[1.06] text-[#1d1d1f] sm:text-[40px] dark:text-[#f5f5f7]">
              {slides[displayIndex]?.title}{" "}
              <br />
              <span>{slides[displayIndex]?.accent}</span>
            </h2>
            <p className="mx-auto max-w-[20rem] text-[16px] text-[rgba(0,0,0,0.56)] leading-[1.45] sm:text-[17px] dark:text-[rgba(245,245,247,0.60)]">
              {slides[displayIndex]?.subtitle}
            </p>
          </div>

          <div className="min-h-0 flex-1 flex items-center">
            <Carousel
              opts={{ align: "center", containScroll: "trimSnaps" }}
              setApi={setApi}
              className="w-full"
              aria-label="Onboarding feature preview"
            >
              <CarouselContent className="items-center -ml-0">
                {slides.map((slide, idx) => (
                  <CarouselItem
                    key={idx}
                    aria-label={`Slide ${idx + 1} of ${slides.length}`}
                    aria-current={idx === selectedIndex ? "step" : undefined}
                    className="basis-full pl-0 flex items-center justify-center"
                  >
                    <div className="flex w-full min-h-[clamp(24rem,50vh,31rem)] items-center justify-center px-4 sm:px-6 md:px-8 py-3">
                      <div
                        aria-hidden="true"
                        className="h-[clamp(31rem,58vh,35rem)] w-full max-w-[22rem] sm:max-w-[24rem] md:max-w-[25rem] lg:max-w-[26rem] xl:max-w-[27rem]"
                      >
                        {slide.preview}
                      </div>
                    </div>
                  </CarouselItem>
                ))}
              </CarouselContent>
            </Carousel>
          </div>

          <div className="mt-4 flex flex-col justify-end gap-4">
            <Dots count={slides.length} activeIndex={selectedIndex} />

            <Button
              size="lg"
              fullWidth
              className="mx-auto h-[52px] w-full max-w-md rounded-full bg-[#0066cc] text-[17px] font-medium tracking-normal text-white shadow-none hover:bg-[#0071e3]"
              onClick={handlePrimary}
              showRipple
            >
              {isLast ? "Sign in" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}

function Dots(props: { count: number; activeIndex: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {`Slide ${props.activeIndex + 1} of ${props.count}`}
      </span>
      {Array.from({ length: props.count }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-[7px] rounded-full transition-[width,background-color]",
            i === props.activeIndex
              ? "w-6 bg-[#0071e3]"
              : "w-[7px] bg-black/10 dark:bg-white/15"
          )}
          aria-hidden
        />
      ))}
    </div>
  );
}
