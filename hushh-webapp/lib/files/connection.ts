import { ApiService } from "@/lib/services/api-service";
import type { SharedFilesAccess } from "./shared/store";
import { SharedFilesAdapter } from "./shared/adapter";

type Connection = { shared: SharedFilesAdapter | null; check: () => void };
let connection: Connection | null = null;
export function bindFilesConnection(
  access: SharedFilesAccess,
  shared: boolean,
): () => void {
  const owned: Connection = {
    shared: shared ? new SharedFilesAdapter(access) : null,
    check: access.check,
  };
  connection = owned;
  return () => {
    if (connection === owned) connection = null;
  };
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
