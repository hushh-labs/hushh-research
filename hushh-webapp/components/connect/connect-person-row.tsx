"use client";

import type { ComponentProps, ReactNode } from "react";

import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { connectPersonName, type ConnectPersonIdentity } from "@/lib/connections/person-label";
import type { DirectoryPerson } from "@/lib/services/connections-service";
import { cn } from "@/lib/utils";

/**
 * One compact person row for Connect's lists, in Feed's ordinary-row anatomy
 * (`components/feed/feed-row.tsx`): a 30px avatar well, the name with one
 * secondary line beneath it, and the actions in a column on the right.
 *
 * Presentation only. Typography comes from the page's `data-profile-type-scale`
 * scope through the same `data-slot` hooks the shared rows use, so this file
 * carries no font values.
 *
 * The profile-opening control and the trailing actions are siblings, never
 * nested: a tap on an action cannot reach the control that opens the person.
 * Names and secondary text wrap, and the row grows with them.
 */
export function ConnectPersonRow({
  leading,
  title,
  description,
  supplement,
  trailing,
  onOpen,
  openLabel,
  voiceLabel,
  testId = "connect-person-row",
  className,
}: {
  /** The avatar, already sized to fit the 30px well. */
  leading: ReactNode;
  title: ReactNode;
  /** Relationship context, such as a connected date. Omitted when empty. */
  description?: ReactNode;
  /** An optional control that belongs under the text column but cannot sit inside the open control. */
  supplement?: ReactNode;
  trailing?: ReactNode;
  onOpen?: () => void;
  /** Accessible name for the open control, e.g. "Open Avery's profile". */
  openLabel?: string;
  voiceLabel?: string;
  testId?: string;
  className?: string;
}) {
  const identity = (
    <>
      {/* Centered on the text block, as in Feed's rows: pinned to the top it sat above
          a one-line name and half a line above a name with a second line. */}
      <span className="grid w-[30px] place-items-center self-center">{leading}</span>
      <span className="min-w-0">
        <span
          data-slot="settings-row-title"
          className="block [overflow-wrap:anywhere]"
        >
          {title}
        </span>
        {description ? (
          <span
            data-slot="settings-row-description"
            className="mt-px block [overflow-wrap:anywhere]"
          >
            {description}
          </span>
        ) : null}
      </span>
    </>
  );
  const identityClassName =
    "grid min-h-[52px] w-full min-w-0 grid-cols-[30px_minmax(0,1fr)] items-center gap-x-2 py-1.5 text-left";

  return (
    <div
      data-testid={testId}
      data-row-layout="person-compact"
      data-voice-label={voiceLabel}
      className={cn(
        "relative isolate grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1 after:pointer-events-none after:absolute after:bottom-0 after:left-[38px] after:right-0 after:h-px after:bg-[color:var(--app-separator)] after:content-[''] last:after:hidden",
        className,
      )}
    >
      <div className="min-w-0">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={openLabel}
            className={cn(
              identityClassName,
              "rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] active:bg-foreground/[0.065] motion-reduce:transition-none [@media(hover:hover)]:hover:bg-foreground/[0.04]",
            )}
          >
            {identity}
          </button>
        ) : (
          <div className={identityClassName}>{identity}</div>
        )}
        {supplement ? <div className="-mt-1 pb-1.5 pl-[38px]">{supplement}</div> : null}
      </div>
      {trailing ? (
        <div
          data-slot="settings-row-trailing"
          className="flex shrink-0 items-center self-center"
        >
          {trailing}
        </div>
      ) : null}
    </div>
  );
}

/** Discovery shows a name, never contact identifiers or masked contact captions. */
export function ConnectDirectoryPersonRow({
  person,
  ...props
}: Omit<ComponentProps<typeof ConnectPersonRow>, "title" | "description"> & {
  person: ConnectPersonIdentity & Partial<Pick<DirectoryPerson, "relationship">>;
}) {
  return (
    <ConnectPersonRow
      {...props}
      title={connectPersonName(person)}
      description={person.relationship === "pending_outgoing"
        ? "Request sent"
        : person.relationship === "pending_incoming" ? "Wants to connect" : undefined}
    />
  );
}

/**
 * The server-backed mutual-connection count under a directory row's text, with
 * the named preview only as an avatar and an accessible name. Renders nothing
 * when there are no mutual connections. The profile-opening control is a
 * button when the caller can open the list or the single mutual profile.
 */
export function DirectoryMutualLine({
  person,
  onOpenMutual,
}: {
  person: DirectoryPerson;
  onOpenMutual?: () => void;
}) {
  const count = person.mutualConnectionCount ?? 0;
  if (count <= 0) return null;
  const preview = person.mutualConnectionPreview;
  const previewName = preview ? connectPersonName(preview) : "Hussh member";
  const label = count === 1 ? "Mutual connection" : `${count} mutual connections`;
  const content = (
    <>
      {preview ? (
        <ConnectionPersonAvatar
          size="compact"
          className="!size-4 shrink-0"
          fallbackClassName="bg-foreground/10 text-[8px]"
          photoUrl={preview.photoUrl}
          label={previewName}
        />
      ) : null}
      <span data-slot="settings-row-description" className="min-w-0 [overflow-wrap:anywhere]">
        {label}
      </span>
    </>
  );
  const lineClassName = "flex min-w-0 items-center gap-1.5 text-left";
  return onOpenMutual ? (
    <button
      type="button"
      onClick={onOpenMutual}
      aria-label={count > 1 ? `View all ${count} mutual connections with ${connectPersonName(person)}` : `Open mutual connection ${previewName}'s profile`}
      data-testid="mutual-connection"
      className={cn(
        lineClassName,
        "relative rounded-md before:absolute before:inset-x-0 before:-inset-y-3 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]",
      )}
    >
      {content}
    </button>
  ) : (
    <div data-testid="mutual-connection" className={lineClassName}>
      {content}
    </div>
  );
}
