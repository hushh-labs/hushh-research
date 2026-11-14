import { ApiService } from "@/lib/services/api-service";
import type { SharedFilesAccess } from "./shared/store";
import { SharedFilesAdapter } from "./shared/adapter";
import { SharedWikiLibrary, WikiRefusedError } from "./wiki";

type Connection = {
  shared: SharedFilesAdapter | null;
  wiki: SharedWikiLibrary | null;
  check: () => void;
};
let connection: Connection | null = null;
export function bindFilesConnection(
  access: SharedFilesAccess,
  shared: boolean,
): () => void {
  const owned: Connection = {
    shared: shared ? new SharedFilesAdapter(access) : null,
    wiki: shared ? new SharedWikiLibrary(access) : null,
    check: access.check,
  };
  connection = owned;
  return () => {
    if (connection === owned) connection = null;
  };
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
