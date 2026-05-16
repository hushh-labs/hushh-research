"use client";

import Link from "next/link";

import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { Button } from "@/lib/morphy-ux/button";

import type { PermissionRule } from "./permission-rules";

interface PermissionLockedStateProps {
  rule: PermissionRule;
  state?: "restricted" | "unavailable";
}

export function PermissionLockedState({ rule, state = "restricted" }: PermissionLockedStateProps) {
  const description =
    state === "unavailable"
      ? "Permission status is unavailable right now. Review permissions before continuing."
      : rule.description;

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
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>

        <Button asChild size="sm" variant="blue" showRipple>
          <Link href="/consents">Review permissions</Link>
        </Button>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
