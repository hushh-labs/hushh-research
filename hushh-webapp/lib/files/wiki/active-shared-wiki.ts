import {
  snapshotValidatedAuthSessionOwner,
  subscribeAuthSessionGeneration,
} from "@/lib/auth/session-owner";
import { subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
  subscribeVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import { SharedFilesStore, type SharedFilesAccess } from "../shared/store";
import { SharedWikiLibrary } from "./library";

type ScopedSharedWiki = {
  userId: string;
  epoch: number;
  vaultKey: string;
  token: string;
  readToken: () => string | null;
  store: SharedFilesStore;
  wiki: SharedWikiLibrary;
  dispose: () => void;
};

let explicitBoundWiki: SharedWikiLibrary | null = null;
let scopedEntry: ScopedSharedWiki | null = null;

export function bindActiveSharedWiki(wiki: SharedWikiLibrary | null): () => void {
  explicitBoundWiki = wiki;
  return () => {
    if (explicitBoundWiki === wiki) {
      explicitBoundWiki = null;
    }
  };
}

export function ensureActiveSharedWiki(input: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  vaultEpoch?: number;
  readToken?: () => string | null;
}): SharedWikiLibrary | null {
  const userId = input.userId.trim();
  const vaultKey = input.vaultKey.trim();
  const token = input.vaultOwnerToken.trim();
  if (!userId || !vaultKey || !token) return null;

  const epoch = input.vaultEpoch ?? snapshotVaultSessionEpoch();
  if (
    scopedEntry &&
    scopedEntry.userId === userId &&
    scopedEntry.epoch === epoch &&
    scopedEntry.vaultKey === vaultKey
  ) {
    scopedEntry.token = token;
    if (input.readToken) {
      scopedEntry.readToken = input.readToken;
    }
    return scopedEntry.wiki;
  }

  scopedEntry?.dispose();

  const cleanups: Array<() => void> = [];
  const entryRef: { current: ScopedSharedWiki | null } = { current: null };

  const liveToken = () => {
    const active = entryRef.current;
    if (!active) return null;
    const candidate = active.readToken() ?? active.token;
    return candidate && candidate.trim() ? candidate.trim() : null;
  };

  const isCurrent = () => {
    const active = entryRef.current;
    if (!active || scopedEntry !== active) return false;
    if (!isVaultSessionEpochCurrent(active.epoch)) return false;
    const owner = snapshotValidatedAuthSessionOwner();
    if (owner && owner.userId !== active.userId) return false;
    return Boolean(liveToken());
  };

  const access: SharedFilesAccess = {
    owner: userId,
    vaultKey,
    get ownerToken() {
      const currentToken = liveToken();
      if (!currentToken) throw new DOMException("Vault session changed", "AbortError");
      return currentToken;
    },
    check: () => {
      if (!isCurrent()) {
        throw new DOMException("Vault session changed", "AbortError");
      }
    },
  };

  const store = new SharedFilesStore(access);
  const wiki = new SharedWikiLibrary(access, store);
  const entry: ScopedSharedWiki = {
    userId,
    epoch,
    vaultKey,
    token,
    readToken: input.readToken ?? (() => entry.token),
    store,
    wiki,
    dispose: () => {
      entry.token = "";
      entry.readToken = () => null;
      for (const cleanup of cleanups.splice(0)) cleanup();
      if (scopedEntry === entry) scopedEntry = null;
      if (explicitBoundWiki === wiki) explicitBoundWiki = null;
      entryRef.current = null;
    },
  };
  entryRef.current = entry;
  scopedEntry = entry;

  const invalidate = () => {
    if (!isCurrent()) entry.dispose();
  };
  cleanups.push(
    subscribeVaultSessionEpoch(invalidate),
    subscribeAuthSessionGeneration(invalidate),
    subscribeDurableOwnerReset((resetOwner) => {
      if (resetOwner === userId) entry.dispose();
    }),
  );

  return wiki;
}

export function peekActiveSharedWiki(): SharedWikiLibrary | null {
  if (explicitBoundWiki) {
    try {
      explicitBoundWiki.access.check();
      return explicitBoundWiki;
    } catch {
      explicitBoundWiki = null;
    }
  }
  if (scopedEntry) {
    try {
      scopedEntry.wiki.access.check();
      return scopedEntry.wiki;
    } catch {
      scopedEntry.dispose();
    }
  }
  return null;
}
