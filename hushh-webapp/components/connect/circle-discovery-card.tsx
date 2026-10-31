"use client";
import { useId, useState } from "react";
import { ChevronDown, X } from "@/components/icons";
import { Button } from "@/lib/morphy-ux/button";
import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";
import type { OneLocationCircleMember } from "@/lib/one-location/types";
import {
  CIRCLE_STARTERS,
  findStarterCircle,
  type CircleStarter,
  type CircleStarterId,
  type ConnectCirclesSnapshot,
} from "./circle-discovery";
import styles from "./connect-workspace.module.css";

export type CircleDiscoveryCardProps = {
  ownerName: string;
  ownerPhotoUrl?: string | null;
  connections: readonly ConnectionSummaryEntry[];
  totalCount: number;
  loading: boolean;
  error: boolean;
  snapshot: ConnectCirclesSnapshot;
  loadCircleMembers?: (
    circleId: string,
  ) => Promise<readonly OneLocationCircleMember[]>;
  creating: CircleStarterId | null;
  onFindPeople: () => void;
  onCreateCircle: () => void;
  onUseStarter: (starter: CircleStarter) => void;
  onOpenCircle: (circleId: string) => void;
  onRetry: () => void;
  onRetryCircles: () => void;
  onSetupCircles: () => void;
};

export function CircleDiscoveryCard({
  snapshot,
  creating,
  onUseStarter,
  onRetryCircles,
  onSetupCircles,
}: CircleDiscoveryCardProps) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState<CircleStarterId[]>([]);
  const unavailable = !snapshot.loading && Boolean(snapshot.error);
  const needsSetup = !snapshot.loading && !snapshot.available && !unavailable;
  const suggestions = CIRCLE_STARTERS.filter(
    (starter) =>
      !hidden.includes(starter.id) &&
      !findStarterCircle(snapshot.circles, starter),
  );
  return (
    <section
      data-testid="connect-living-connections"
      data-circle-discovery-card=""
      className={styles.ideas}
    >
      <div className={styles.ideaHeader}>
        <button
          type="button"
          className={styles.ideaToggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          Circle ideas <span className={styles.optional}>Optional</span>
          <ChevronDown
            aria-hidden="true"
            className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        {hidden.length ? (
          <Button
            type="button"
            variant="none"
            effect="fade"
            size="compact"
            className={styles.quietAction}
            onClick={() => setHidden([])}
          >
            Restore hidden
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <div id={contentId} data-circle-discovery-content="">
          {suggestions.map((starter) => (
            <div
              key={starter.id}
              className={styles.ideaRow}
              data-testid={`circle-starter-${starter.id}`}
            >
              <button
                type="button"
                disabled={snapshot.loading || Boolean(creating) || unavailable}
                onClick={() =>
                  needsSetup ? onSetupCircles() : onUseStarter(starter)
                }
                aria-label={`Setup ${starter.label} circle`}
              >
                <strong>
                  {creating === starter.id ? "Creating…" : starter.label}
                </strong>
                <small>{starter.description}</small>
              </button>
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="icon-touch"
                aria-label={`Hide ${starter.label} suggestion`}
                disabled={Boolean(creating)}
                onClick={() => setHidden((current) => [...current, starter.id])}
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            </div>
          ))}
          {!suggestions.length ? (
            <p className="py-4 text-xs text-muted-foreground">
              No suggestions to show.
            </p>
          ) : null}
          {unavailable ? (
            <Button
              type="button"
              variant="none"
              effect="fade"
              size="compact"
              onClick={onRetryCircles}
            >
              Retry circles
            </Button>
          ) : null}
          {needsSetup ? (
            <Button
              type="button"
              variant="none"
              effect="fade"
              size="compact"
              onClick={onSetupCircles}
            >
              Finish setting up One
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
