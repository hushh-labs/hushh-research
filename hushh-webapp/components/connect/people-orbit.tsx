"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { User } from "@/components/icons";
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
  emptySlots,
  onOpenPerson,
  profileHrefForPerson,
  className,
}: {
  people: readonly OrbitPerson[];
  totalCount: number;
  capacity: number;
  center: ReactNode;
  emptyAdornment?: ReactNode;
  emptySlots: number;
  onOpenPerson?: (personRef: string) => void;
  profileHrefForPerson?: (personRef: string) => string;
  className: string;
}) {
  const count = Math.max(0, totalCount);
  const shown = people.slice(0, count > capacity ? capacity - 1 : capacity);
  const remaining = Math.max(0, count - shown.length);
  const occupiedSlots = shown.length + (remaining ? 1 : 0);
  // Never use decorative spots to represent members whose previews aren't loaded.
  const placeholders = remaining
    ? 0
    : Math.max(0, Math.min(capacity - occupiedSlots, emptySlots));
  const slots = occupiedSlots + placeholders;

  return (
    <div className={className}>
      {slots || emptyAdornment ? (
        <span
          aria-hidden="true"
          className="absolute inset-[12%] rounded-full border border-[color:var(--app-card-border-standard)]"
        />
      ) : null}
      <div
        data-orbit-center=""
        className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
      >
        {center}
      </div>
      {!slots && emptyAdornment ? (
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-[12%] z-10 -translate-x-1/2 -translate-y-1/2"
        >
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
        const sharedClass =
          "group absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]";
        return profileHrefForPerson && person.publicPersonRef ? (
          <Link
            key={person.id}
            href={profileHrefForPerson(person.publicPersonRef)}
            className={`${sharedClass} cursor-pointer`}
            style={style}
            title={person.name}
            aria-label={`Open ${person.name}'s profile`}
          >
            {avatar}
          </Link>
        ) : onOpenPerson && person.publicPersonRef ? (
          <button
            key={person.id}
            type="button"
            className={`${sharedClass} cursor-pointer`}
            style={style}
            title={person.name}
            aria-label={`Open ${person.name}'s profile`}
            onClick={() => onOpenPerson(person.publicPersonRef!)}
          >
            {avatar}
          </button>
        ) : (
          <span
            key={person.id}
            className={sharedClass}
            style={style}
            title={person.name}
            aria-label={person.name}
          >
            {avatar}
          </span>
        );
      })}
      {Array.from({ length: placeholders }, (_, index) => {
        const angle =
          -Math.PI / 2 + ((occupiedSlots + index) * 2 * Math.PI) / slots;
        return (
          <span
            key={`empty-${index}`}
            aria-hidden="true"
            data-circle-empty-spot=""
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
            style={{
              left: `${50 + Math.cos(angle) * 38}%`,
              top: `${50 + Math.sin(angle) * 38}%`,
            }}
          >
            <span className="motion-step-enter flex size-10 sm:size-11 items-center justify-center rounded-full border border-dashed border-[color:var(--app-accent)] bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent)]">
              <User className="size-5" />
            </span>
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
  emptySlots = 0,
  onOpenPerson,
  profileHrefForPerson,
}: {
  people: readonly OrbitPerson[];
  totalCount: number;
  center: ReactNode;
  emptyAdornment?: ReactNode;
  /** Decorative open spots only; never included in member or overflow counts. */
  emptySlots?: number;
  onOpenPerson?: (personRef: string) => void;
  profileHrefForPerson?: (personRef: string) => string;
}) {
  return (
    <div
      className="relative mx-auto size-[14rem] sm:size-[17rem]"
      data-testid="people-orbit"
    >
      <OrbitLayout
        people={people}
        totalCount={totalCount}
        capacity={4}
        center={center}
        emptyAdornment={emptyAdornment}
        emptySlots={emptySlots}
        onOpenPerson={onOpenPerson}
        profileHrefForPerson={profileHrefForPerson}
        className="relative size-full sm:hidden"
      />
      <OrbitLayout
        people={people}
        totalCount={totalCount}
        capacity={6}
        center={center}
        emptyAdornment={emptyAdornment}
        emptySlots={emptySlots}
        onOpenPerson={onOpenPerson}
        profileHrefForPerson={profileHrefForPerson}
        className="relative hidden size-full sm:block"
      />
    </div>
  );
}
