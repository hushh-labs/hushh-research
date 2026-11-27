"use client";

import { useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
  type AppPageShellWidth,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import { cn } from "@/lib/utils";
import { ROUTES, normalizeStaticExportPathname } from "@/lib/navigation/routes";

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
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const isMemoryWorkspace = pathname === ROUTES.PKM;
  const shellRef = useRef<HTMLDivElement | null>(null);

  return (
    <AppPageShell as="div" width={shellWidth} headerContentSpacing={titleRole === "agent" && !isMemoryWorkspace ? "compact" : "standard"}>
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

      <AppPageContentRegion className={isMemoryWorkspace ? "!mt-4" : undefined}>
        <div ref={shellRef} className={cn("w-full space-y-4", innerClassName)}>
          <div data-pkm-detail-panel="true" data-pkm-workspace={pathname === ROUTES.PKM || pathname?.startsWith(`${ROUTES.PKM}/`) ? "true" : undefined}>
            <SurfaceStack compact>{children}</SurfaceStack>
          </div>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
