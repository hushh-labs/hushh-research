"use client";

/**
 * The note you write about a place you visited, and the private history it
 * builds.
 *
 * Stored exactly the way Saved Places are: client-side encrypted in the
 * Location PKM domain, through `PkmDomainResourceService` and
 * `PkmWriteCoordinator`, under a key of its own. It never reaches a Hushh
 * server in plaintext, and the rating endpoint deliberately has no note field
 * for it to arrive in.
 *
 * That is not caution for its own sake. A note is free text about a real,
 * named business -- "the manager was rude", a phone number, somebody's name --
 * and a plaintext copy of that on our servers, next to a venue and a
 * timestamp, is a movement log with commentary and the entire surface area of
 * defamation and third-party-PII risk this feature could otherwise have. Kept
 * in the author's vault it is a diary, which is what it was meant to be.
 *
 * The star rating is the half that DOES go to the server, because an average
 * and one-vote-per-place cannot be computed on a device. The two halves are
 * written independently on purpose: a locked vault costs the note, not the
 * rating.
 */

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { LOCATION_PKM_DOMAIN } from "@/lib/one-location/saved-locations";

const VISIT_NOTES_KEY = "visit_notes";
const VISIT_NOTES_SCHEMA_VERSION = 1;

/** Two lines on a history row is the whole budget, and it is a note to
 *  yourself rather than an essay. Enforced with `maxLength` so the cap is felt
 *  while typing rather than announced on save, which loses what you wrote. */
export const VISIT_NOTE_MAX_LENGTH = 280;

/** How many places the private history keeps. Older entries fall off rather
 *  than accumulating an unbounded trail inside the vault. */
export const VISIT_NOTES_MAX_ENTRIES = 200;

export type VisitNote = {
  placeId: string;
  label: string;
  rating: number;
  note: string | null;
  visitedAt: string | null;
  ratedAt: string;
};

export type VisitNoteVaultContext = {
  userId: string;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
};

/** True when the vault can be written to. The caller degrades to star-only
 *  rather than hiding the whole pane, so a locked vault costs the note and
 *  nothing else. */
export function canWriteVisitNotes(
  context: VisitNoteVaultContext | null | undefined,
): boolean {
  return Boolean(context?.userId && context?.vaultKey && context?.vaultOwnerToken);
}

function cleanNote(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, VISIT_NOTE_MAX_LENGTH);
}

function notesFromDomain(domainData: unknown): VisitNote[] {
  const envelope = (domainData as Record<string, unknown> | null | undefined)?.[
    VISIT_NOTES_KEY
  ] as { visits?: unknown } | undefined;
  const rows = Array.isArray(envelope?.visits) ? envelope?.visits : [];
  return rows.flatMap((row): VisitNote[] => {
    if (!row || typeof row !== "object") return [];
    const entry = row as Record<string, unknown>;
    const placeId = String(entry.placeId ?? "").trim();
    const rating = Number(entry.rating);
    if (!placeId || !Number.isFinite(rating)) return [];
    return [
      {
        placeId,
        label: String(entry.label ?? "").trim(),
        rating: Math.min(5, Math.max(1, Math.round(rating))),
        note: cleanNote(entry.note as string | null),
        visitedAt: entry.visitedAt ? String(entry.visitedAt) : null,
        ratedAt: String(entry.ratedAt ?? new Date().toISOString()),
      },
    ];
  });
}

/** The private history: every place you rated, newest first. */
export async function loadVisitNotes(
  context: VisitNoteVaultContext,
): Promise<VisitNote[]> {
  if (!canWriteVisitNotes(context)) return [];
  const snapshot = await PkmDomainResourceService.getStaleFirst({
    userId: context.userId,
    domain: LOCATION_PKM_DOMAIN,
    vaultKey: context.vaultKey as string,
    vaultOwnerToken: context.vaultOwnerToken as string,
    backgroundRefresh: false,
  }).catch(() => null);
  return notesFromDomain(snapshot?.data);
}

/**
 * Record one rated visit, replacing any earlier entry for the same place.
 *
 * One entry per place, matching the server's one-vote-per-place rule, so the
 * history reads as "places you've been" rather than a log of every trip.
 */
export async function recordVisitNote(params: {
  context: VisitNoteVaultContext;
  entry: {
    placeId: string;
    label: string;
    rating: number;
    note?: string | null;
    visitedAt?: string | null;
  };
}): Promise<VisitNote[]> {
  const { context, entry } = params;
  if (!canWriteVisitNotes(context)) {
    throw new Error("Unlock your vault to keep a note with this rating.");
  }

  const record: VisitNote = {
    placeId: String(entry.placeId).trim(),
    label: String(entry.label ?? "").trim(),
    rating: Math.min(5, Math.max(1, Math.round(Number(entry.rating)))),
    note: cleanNote(entry.note),
    visitedAt: entry.visitedAt ?? null,
    ratedAt: new Date().toISOString(),
  };

  let persisted: VisitNote[] = [];
  await PkmWriteCoordinator.saveMergedDomain({
    userId: context.userId,
    domain: LOCATION_PKM_DOMAIN,
    vaultKey: context.vaultKey as string,
    vaultOwnerToken: context.vaultOwnerToken as string,
    confirmation: {
      confirmedByUser: true,
      surface: "web",
      source: "one_location_visit_rated",
    },
    build: (writeContext) => {
      const existing = notesFromDomain(writeContext.currentDomainData).filter(
        (row) => row.placeId !== record.placeId,
      );
      persisted = [record, ...existing].slice(0, VISIT_NOTES_MAX_ENTRIES);
      const domainData = {
        ...(writeContext.currentDomainData as Record<string, unknown>),
        [VISIT_NOTES_KEY]: {
          schema_version: VISIT_NOTES_SCHEMA_VERSION,
          visits: persisted,
          updated_at: record.ratedAt,
        },
      };
      const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
        domain: LOCATION_PKM_DOMAIN,
        domainData,
        previousManifest: writeContext.currentManifest,
      });
      return {
        domainData,
        manifest,
        scopePath: VISIT_NOTES_KEY,
        // The readable projection carries counts, never a place or a note.
        summary: {
          rated_visits_recorded: persisted.length > 0,
          rated_visits_count: persisted.length,
        },
      };
    },
  });
  return persisted;
}

/** Forget one place. Pairs with deleting the server-side rating. */
export async function removeVisitNote(params: {
  context: VisitNoteVaultContext;
  placeId: string;
}): Promise<VisitNote[]> {
  const { context } = params;
  if (!canWriteVisitNotes(context)) return [];
  const placeId = String(params.placeId).trim();

  let persisted: VisitNote[] = [];
  await PkmWriteCoordinator.saveMergedDomain({
    userId: context.userId,
    domain: LOCATION_PKM_DOMAIN,
    vaultKey: context.vaultKey as string,
    vaultOwnerToken: context.vaultOwnerToken as string,
    confirmation: {
      confirmedByUser: true,
      surface: "web",
      source: "one_location_visit_rating_removed",
    },
    build: (writeContext) => {
      persisted = notesFromDomain(writeContext.currentDomainData).filter(
        (row) => row.placeId !== placeId,
      );
      const domainData = {
        ...(writeContext.currentDomainData as Record<string, unknown>),
        [VISIT_NOTES_KEY]: {
          schema_version: VISIT_NOTES_SCHEMA_VERSION,
          visits: persisted,
          updated_at: new Date().toISOString(),
        },
      };
      const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
        domain: LOCATION_PKM_DOMAIN,
        domainData,
        previousManifest: writeContext.currentManifest,
      });
      return {
        domainData,
        manifest,
        scopePath: VISIT_NOTES_KEY,
        summary: {
          rated_visits_recorded: persisted.length > 0,
          rated_visits_count: persisted.length,
        },
      };
    },
  });
  return persisted;
}
