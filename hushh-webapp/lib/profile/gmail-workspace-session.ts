"use client";

import { getSessionItem, setSessionItem } from "@/lib/utils/session-storage";

export type GmailWorkspaceSessionValue = "overview" | "kyc" | "receipts";

const STORAGE_PREFIX = "hushh.gmail.workspace.v1";

function isWorkspace(value: string | null): value is GmailWorkspaceSessionValue {
  return value === "overview" || value === "kyc" || value === "receipts";
}

function storageKey(userId: string, pathname: string): string {
  return `${STORAGE_PREFIX}:${userId}:${pathname}`;
}

/**
 * Retains only the active Gmail view for the current signed-in browser session.
 * KYC drafts, Gmail content, and vault material remain memory-only.
 */
export function getGmailWorkspaceSession(
  userId: string | null | undefined,
  pathname: string | null | undefined,
  fallback: GmailWorkspaceSessionValue,
): GmailWorkspaceSessionValue {
  const normalizedUserId = String(userId || "").trim();
  const normalizedPathname = String(pathname || "").trim();
  if (!normalizedUserId || !normalizedPathname) return fallback;

  const savedWorkspace = getSessionItem(
    storageKey(normalizedUserId, normalizedPathname),
  );
  return isWorkspace(savedWorkspace) ? savedWorkspace : fallback;
}

export function setGmailWorkspaceSession(
  userId: string | null | undefined,
  pathname: string | null | undefined,
  workspace: GmailWorkspaceSessionValue,
): void {
  const normalizedUserId = String(userId || "").trim();
  const normalizedPathname = String(pathname || "").trim();
  if (!normalizedUserId || !normalizedPathname) return;

  setSessionItem(storageKey(normalizedUserId, normalizedPathname), workspace);
}
