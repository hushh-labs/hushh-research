import {
  ensureLocalIntentPack,
  fetchLocalRuntimeCapability,
} from "./local-runtime-capability";
import { LocalModelPackStore } from "./local-runtime-model-store";
import { OnnxIntentRanker } from "./local-intent-ranker";
import {
  CatalogBoundOneVoiceIntentResolver,
  type OneVoiceIntentResolver,
} from "./local-intent-resolver";

export type PreparedLocalIntentResolver = OneVoiceIntentResolver & {
  dispose: () => void;
};

/**
 * Prepare the session-local ranker when deployment has published a verified
 * intent pack. Missing capability metadata, an unavailable model, or a worker
 * failure returns the catalog-bound deterministic fallback. No cloud provider
 * is selected here; the caller decides whether an unresolved turn may use its
 * explicit hybrid path.
 */
export async function prepareLocalIntentResolver(options?: {
  store?: LocalModelPackStore;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<PreparedLocalIntentResolver> {
  const fallback = new CatalogBoundOneVoiceIntentResolver();
  try {
    const capability = await fetchLocalRuntimeCapability(options?.fetchImpl);
    const store = options?.store ?? new LocalModelPackStore();
    const pack = await ensureLocalIntentPack(capability, {
      store,
      fetchImpl: options?.fetchImpl,
      signal: options?.signal,
    });
    if (!pack) return withDispose(fallback);
    const modelBytes = await store.readInstalled(pack);
    if (!modelBytes) return withDispose(fallback);
    const ranker = new OnnxIntentRanker(
      modelBytes,
      pack.preprocessing_version,
    );
    return withDispose(
      new CatalogBoundOneVoiceIntentResolver({ ranker }),
    );
  } catch {
    return withDispose(fallback);
  }
}

function withDispose(
  resolver: CatalogBoundOneVoiceIntentResolver,
): PreparedLocalIntentResolver {
  return resolver as PreparedLocalIntentResolver;
}
