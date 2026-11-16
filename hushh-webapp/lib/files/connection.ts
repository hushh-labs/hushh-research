import { ApiService } from "@/lib/services/api-service";
import type { SharedFilesAccess } from "./shared/store";
import { SharedFilesAdapter } from "./shared/adapter";
import { SharedWikiLibrary, WikiRefusedError } from "./wiki";
import {
  bindActiveSharedWiki,
  ensureActiveSharedWiki,
} from "./wiki/active-shared-wiki";

type Connection = {
  access: SharedFilesAccess;
  shared: SharedFilesAdapter | null;
  wiki: SharedWikiLibrary | null;
  check: () => void;
};
let connection: Connection | null = null;

export function bindFilesConnection(
  access: SharedFilesAccess,
  shared: boolean,
): () => void {
  const scopedWiki = shared
    ? ensureActiveSharedWiki({
        userId: access.owner,
        vaultKey: access.vaultKey,
        vaultOwnerToken: access.ownerToken,
        readToken: () => {
          try {
            access.check();
            return access.ownerToken;
          } catch {
            return null;
          }
        },
      }) ?? new SharedWikiLibrary(access)
    : null;
  const owned: Connection = {
    access,
    shared:
      shared && scopedWiki
        ? new SharedFilesAdapter(access, scopedWiki)
        : null,
    wiki: scopedWiki,
    check: access.check,
  };
  connection = owned;
  const releaseWiki = bindActiveSharedWiki(owned.wiki);
  return () => {
    releaseWiki();
    if (connection === owned) connection = null;
  };
}

export function activeFilesAccess(): SharedFilesAccess | null {
  const owned = connection;
  if (!owned) return null;
  try {
    owned.check();
    return owned.access;
  } catch {
    return null;
  }
}

export function sharedWikiLibrary(): SharedWikiLibrary {
  const owned = connection;
  if (!owned) throw new Error("FILES_UNLOCK_REQUIRED");
  owned.check();
  if (!owned.wiki) {
    throw new WikiRefusedError("WIKI_SHARED_RUNTIME_REQUIRED", 409);
  }
  return owned.wiki;
}

export async function filesRequest(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const owned = connection;
  if (!owned) throw new Error("FILES_UNLOCK_REQUIRED");
  owned.check();
  const response = owned?.shared
    ? await owned.shared.request(path, init)
    : await ApiService.ownerPodRequest(`files/${path}`, init);
  owned?.check();
  if (owned && connection !== owned)
    throw new DOMException("Files session changed", "AbortError");
  return response;
}
