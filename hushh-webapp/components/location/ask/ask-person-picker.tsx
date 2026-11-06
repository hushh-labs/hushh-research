"use client";

import Link from "next/link";
import { Loader2, UserPlus } from "@/components/icons";
import { PersonSelectionSurface } from "@/components/connections/person-selection-surface";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { useConnectedPeople } from "@/components/location/people/location-people";
import { Button } from "@/components/ui/button";
import { MUTED_TEXT, SUBCARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import { EmptyState } from "@/lib/morphy-ux/ui/surface-primitives";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

export function PersonPicker({
  vaultOwnerToken,
  onPick,
}: {
  vaultOwnerToken: string | null;
  onPick: (userId: string) => void;
}) {
  const people = useConnectedPeople({ vaultOwnerToken });
  if (people.status === "loading" && !people.items.length) {
    return (
      <div className="flex items-center gap-2 px-1 py-4 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span className={MUTED_TEXT}>Loading your people</span>
      </div>
    );
  }
  if (people.status === "ready" && !people.items.length) {
    return (
      <EmptyState
        icon={<UserPlus className="h-6 w-6" aria-hidden="true" />}
        title="No one to ask yet"
        description="Location requests go to people you're connected with on One."
        action={
          <Button asChild className="min-h-11">
            <Link href={ROUTES.CONNECT}>Invite someone</Link>
          </Button>
        }
      />
    );
  }
  return (
    <div className="space-y-2" role="list" aria-label="Choose whom to ask">
      {people.items.map((recipient) => (
        <PersonSelectionSurface
          key={recipient.userId}
          type="button"
          role="listitem"
          onClick={() => onPick(recipient.userId)}
          className={cn(
            SUBCARD_SURFACE,
            "flex min-h-[58px] w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-[color:var(--app-card-surface-compact)]",
          )}
          data-testid="ask-person-option"
        >
          <ConnectionPersonAvatar userId={recipient.userId}
            label={recipient.displayName}
            photoUrl={recipient.photoUrl}
            verified={recipient.phoneVerified}
          />
          <span className="min-w-0 flex-1">
            <span className="ui-text-row-label block truncate">
              {recipient.displayName}
            </span>
          </span>
        </PersonSelectionSurface>
      ))}
      {people.hasMore ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full"
          disabled={people.status === "loading"}
          onClick={() => void people.loadMore()}
        >
          Show more
        </Button>
      ) : null}
    </div>
  );
}
