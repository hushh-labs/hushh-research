"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { Button } from "@/lib/morphy-ux/button";

import type { PermissionRule } from "./permission-rules";

interface PermissionLockedStateProps {
  rule: PermissionRule;
}

export function PermissionLockedState({ rule }: PermissionLockedStateProps) {
  // Tag the current route as origin so the consent center's back button
  // retraces here instead of falling to Profile (breadcrumb reads ?from).
  const pathname = usePathname();
  return (
    <SurfaceCard accent="consent" data-testid="permission-locked-state">
      <SurfaceCardContent className="space-y-4 p-5">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {rule.eyebrow}
          </p>
          <h3 className="text-base font-semibold tracking-tight text-foreground">
            {rule.title}
          </h3>
          <p className="text-sm text-muted-foreground">{rule.description}</p>
        </div>

        <Button asChild size="sm" variant="blue" showRipple>
          <Link href={buildConsentCenterHref("pending", { from: pathname || undefined })}>
            Review permissions
          </Link>
        </Button>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
