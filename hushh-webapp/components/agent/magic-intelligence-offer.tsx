"use client";

import type { ReactNode } from "react";
import { HelperText } from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import { Card } from "@/lib/morphy-ux/card";
import type { ProfileResearchAvailability } from "./profile-research-card";

/** Compact entry point; findings and consent controls stay behind explicit review. */
export function MagicIntelligenceOffer(props: {
  profile: ProfileResearchAvailability;
  businessAvailable: boolean;
  expanded: boolean;
  onReview: () => void;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <Card
      preset="compact"
      data-testid="magic-intelligence-card"
      className="min-w-0 w-full gap-1 p-3 sm:p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="ui-text-row-label">Magic Intelligence</h3>
        {props.expanded && (
          <Button variant="none" size="compact" onClick={props.onBack}>
            Back
          </Button>
        )}
      </div>
      {!props.expanded && (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <HelperText>
            {props.profile === "loading" && !props.businessAvailable
              ? "One is looking for more information about you…"
              : props.profile === "failed" && !props.businessAvailable
                ? "One couldn’t look up your profile. Open to retry."
                : props.profile === "empty" && !props.businessAvailable
                  ? "One couldn’t find a reliable public profile for you."
                  : "One found more information about you. Review it before saving to Memory."}
          </HelperText>
          {props.profile !== "loading" || props.businessAvailable ? (
            <Button size="compact" onClick={props.onReview}>
              Review details
            </Button>
          ) : null}
        </div>
      )}
      <div
        hidden={!props.expanded}
        className={props.expanded ? "mt-3 space-y-4" : undefined}
      >
        {props.children}
      </div>
    </Card>
  );
}
