"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
  type AppPageShellWidth,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import { usePageEnterAnimation } from "@/lib/morphy-ux/hooks/use-page-enter";
import {
  ensureMorphyGsapReady,
  getMorphyEaseName,
} from "@/lib/morphy-ux/gsap-init";
import { getGsap, prefersReducedMotion } from "@/lib/morphy-ux/gsap";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/navigation/routes";

export function PkmSettingsShell({
  title,
  description,
  eyebrow,
  actions,
  innerClassName,
  shellWidth = "reading",
  titleRole = "page",
  titleVisuallyHidden = false,
  children,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  /** Keeps a semantic heading available without drawing it in a focused subroute. */
  titleVisuallyHidden?: boolean;
  actions?: ReactNode;
  innerClassName?: string;
  shellWidth?: AppPageShellWidth;
  titleRole?: "page" | "agent";
  children: ReactNode;
}) {
  const pathname = usePathname();
  const shellRef = useRef<HTMLDivElement | null>(null);

  usePageEnterAnimation(shellRef, {
    key: pathname,
  });

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const root = shellRef.current;
    if (!root) return;

    let revert: null | (() => void) = null;
    let cancelled = false;

    void (async () => {
      await ensureMorphyGsapReady();
      const gsap = await getGsap();
      if (!gsap || cancelled) return;

      if (gsap.context) {
        const ctx = gsap.context(() => {
          const navRows = Array.from(
            root.querySelectorAll<HTMLElement>("[data-pkm-nav-row='true']"),
          );
          const detailPanel = root.querySelector<HTMLElement>(
            "[data-pkm-detail-panel='true']",
          );
          if (navRows.length > 0) {
            gsap.fromTo(
              navRows,
              { opacity: 0, x: -12 },
              {
                opacity: 1,
                x: 0,
                duration: 0.28,
                stagger: 0.04,
                ease: getMorphyEaseName("emphasized"),
                overwrite: "auto",
                clearProps: "opacity,transform",
              },
            );
          }
          if (detailPanel) {
            gsap.fromTo(
              detailPanel,
              { opacity: 0, x: 18, scale: 0.992 },
              {
                opacity: 1,
                x: 0,
                scale: 1,
                duration: 0.34,
                ease: getMorphyEaseName("emphasized"),
                overwrite: "auto",
                clearProps: "opacity,transform",
              },
            );
          }
        }, root);
        revert = () => ctx.revert();
      }
    })();

    return () => {
      cancelled = true;
      revert?.();
    };
  }, [pathname]);

  return (
    <AppPageShell as="div" width={shellWidth}>
      <AppPageHeaderRegion>
        <div className={cn("w-full", innerClassName)}>
          <PageHeader
            eyebrow={eyebrow}
            title={title}
            titleRole={titleRole}
            titleVisuallyHidden={titleVisuallyHidden}
            description={description}
            actions={actions}
          />
        </div>
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <div ref={shellRef} className={cn("w-full space-y-4", innerClassName)}>
          <div data-pkm-detail-panel="true" data-pkm-workspace={pathname === ROUTES.PKM || pathname?.startsWith(`${ROUTES.PKM}/`) ? "true" : undefined}>
            <SurfaceStack compact>{children}</SurfaceStack>
          </div>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
