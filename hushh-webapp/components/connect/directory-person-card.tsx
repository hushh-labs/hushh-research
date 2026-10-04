"use client";

import type { ReactNode } from "react";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import type { DirectoryPerson } from "@/lib/services/connections-service";
import { getDirectoryPersonDescription } from "@/app/connect/directory-person-label";

/** Presentation only: the directory page retains every request/selection action. */
export function DirectoryPersonCard({
  person,
  leading,
  title,
  onClick,
  onOpenMutual,
  trailing,
}: {
  person: DirectoryPerson;
  leading: ReactNode;
  title: ReactNode;
  density?: "compact";
  onClick?: () => void;
  onOpenMutual?: () => void;
  trailing: ReactNode;
}) {
  const name = person.displayName || "Hussh member";
  const detail = getDirectoryPersonDescription(person);
  const mutualCount = person.mutualConnectionCount ?? 0;
  const mutual = person.mutualConnectionPreview;
  const mutualProfile = mutual ? (
    <>
      <ConnectionPersonAvatar
        size="compact"
        className="!size-6 shrink-0"
        photoUrl={mutual.photoUrl}
        label={mutual.displayName}
      />
      <span className="min-w-0">
        <span className="block text-[10px] leading-4">
          {mutualCount === 1 ? "Mutual connection" : `${mutualCount} mutual connections`}
        </span>
      </span>
    </>
  ) : null;
  const identity = (
    <>
      <span className="relative -mt-8 flex justify-center [&>span]:!size-16 [&>span]:border-4 [&>span]:border-[color:var(--app-card-surface-default-solid)]">
        {leading}
      </span>
      <span className="ui-text-row-label-compact mt-2 block text-center [overflow-wrap:anywhere]">
        {title}
      </span>
      {detail ? (
        <span className="ui-text-caption mt-1 block text-center text-[color:var(--app-secondary-label)] [overflow-wrap:anywhere]">
          {detail}
        </span>
      ) : null}
    </>
  );
  return (
    <article
      data-testid="directory-person-card"
      className="flex min-w-0 flex-col overflow-hidden rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]"
    >
      <div
        aria-hidden="true"
        className="h-16 bg-gradient-to-br from-[color:var(--app-accent-tint)] to-[color:var(--app-secondary-surface)]"
      />
      <div className="flex flex-1 flex-col px-3 pb-3">
        {onClick ? (
          <button
            type="button"
            onClick={onClick}
            aria-label={`Open ${name}'s profile`}
            className="min-w-0 rounded-[var(--app-radius-sm)] text-[color:var(--app-label)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
          >
            {identity}
          </button>
        ) : (
          <div className="min-w-0">{identity}</div>
        )}
        <div className="mt-auto min-h-14 py-1">
          {mutualCount > 0 ? (
            onOpenMutual && mutual ? (
              <button
                type="button"
                onClick={onOpenMutual}
                aria-label={`Open mutual connection ${mutual.displayName}'s profile`}
                className="flex min-h-11 w-full min-w-0 items-center gap-1.5 rounded-md text-left text-xs text-[color:var(--app-secondary-label)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
                data-testid="mutual-connection"
              >
                {mutualProfile}
              </button>
            ) : (
              <div
                className="flex min-h-11 min-w-0 items-center gap-1.5 text-xs text-[color:var(--app-secondary-label)]"
                data-testid="mutual-connection"
              >
                {mutualProfile ?? `${mutualCount} mutual ${mutualCount === 1 ? "connection" : "connections"}`}
              </div>
            )
          ) : null}
        </div>
        <div className="flex min-h-11 items-center justify-center [&>button:not([role=checkbox])]:!m-0 [&>button:not([role=checkbox])]:!w-full [&>button:not([role=checkbox])]:!border [&>button:not([role=checkbox])]:!border-[color:var(--app-accent)] [&>button:not([role=checkbox])]:!bg-transparent [&>button:not([role=checkbox])]:!text-[color:var(--app-accent)]">
          {trailing}
        </div>
      </div>
    </article>
  );
}
