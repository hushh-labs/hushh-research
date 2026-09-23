"use client";

import type { ReactNode } from "react";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";

export type OrbitPerson = {
  id: string;
  name: string;
  photoUrl?: string | null;
  verified?: boolean;
  publicPersonRef?: string | null;
};

function OrbitLayout({
  people,
  totalCount,
  capacity,
  center,
  emptyAdornment,
  onOpenPerson,
  className,
}: {
  people: readonly OrbitPerson[];
  totalCount: number;
  capacity: number;
  center: ReactNode;
  emptyAdornment?: ReactNode;
  onOpenPerson?: (personRef: string) => void;
  className: string;
}) {
  const count = Math.max(0, totalCount);
  const shown = people.slice(0, count > capacity ? capacity - 1 : capacity);
  const remaining = Math.max(0, count - shown.length);
  const slots = shown.length + (remaining ? 1 : 0);

  return (
    <div className={className}>
      {slots || emptyAdornment ? (
        <span aria-hidden="true" className="absolute inset-[12%] rounded-full border border-[color:var(--app-card-border-standard)]" />
      ) : null}
      <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
        {center}
      </div>
      {!slots && emptyAdornment ? (
        <span aria-hidden="true" className="absolute left-1/2 top-[12%] z-10 -translate-x-1/2 -translate-y-1/2">
          {emptyAdornment}
        </span>
      ) : null}
      {shown.map((person, index) => {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / slots;
        const style = {
          left: `${50 + Math.cos(angle) * 38}%`,
          top: `${50 + Math.sin(angle) * 38}%`,
        };
        const avatar = (
          <span className="block rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-card-surface-default-solid)] shadow-sm transition-transform group-hover:scale-105 motion-reduce:transition-none">
            <ConnectionPersonAvatar
              size="list"
              className="!size-9 sm:!size-10"
              photoUrl={person.photoUrl}
              label={person.name}
              verified={person.verified}
            />
          </span>
        );
        const sharedClass = "group absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]";
        return onOpenPerson && person.publicPersonRef ? (
          <button
            key={person.id}
            type="button"
            className={sharedClass}
            style={style}
            title={person.name}
            aria-label={`Open ${person.name}'s profile`}
            onClick={() => onOpenPerson(person.publicPersonRef!)}
          >
            {avatar}
          </button>
        ) : (
          <span key={person.id} className={sharedClass} style={style} title={person.name} aria-label={person.name}>
            {avatar}
          </span>
        );
      })}
      {remaining ? (
        <span
          data-testid="people-orbit-overflow"
          className="absolute z-10 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-secondary-fill)] text-xs font-semibold text-[color:var(--app-primary-label)] shadow-sm"
          style={{
            left: `${50 + Math.cos(-Math.PI / 2 + ((slots - 1) * 2 * Math.PI) / slots) * 38}%`,
            top: `${50 + Math.sin(-Math.PI / 2 + ((slots - 1) * 2 * Math.PI) / slots) * 38}%`,
          }}
          aria-label={`${remaining} more people`}
        >
          +{remaining}
        </span>
      ) : null}
    </div>
  );
}

/** CSS chooses the viewport layout, so SSR and the first mobile paint agree. */
export function PeopleOrbit({
  people,
  totalCount,
  center,
  emptyAdornment,
  onOpenPerson,
}: {
  people: readonly OrbitPerson[];
  totalCount: number;
  center: ReactNode;
  emptyAdornment?: ReactNode;
  onOpenPerson?: (personRef: string) => void;
}) {
  return (
    <div className="relative mx-auto size-[14rem] sm:size-[17rem]" data-testid="people-orbit">
      <OrbitLayout
        people={people}
        totalCount={totalCount}
        capacity={4}
        center={center}
        emptyAdornment={emptyAdornment}
        onOpenPerson={onOpenPerson}
        className="relative size-full sm:hidden"
      />
      <OrbitLayout
        people={people}
        totalCount={totalCount}
        capacity={6}
        center={center}
        emptyAdornment={emptyAdornment}
        onOpenPerson={onOpenPerson}
        className="relative hidden size-full sm:block"
      />
    </div>
  );
}
