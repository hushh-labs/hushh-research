import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type NativeSessionPrivacyState = Readonly<{
  shielded: boolean;
  generation: number;
  cause: "inactive" | "background" | "restart";
  appIsActive: boolean;
}>;

export type NativeSessionPrivacyEvent = NativeSessionPrivacyState & {
  action: "state" | "retry";
};

export type NativeSessionPrivacyCompletion = NativeSessionPrivacyState &
  Readonly<{
    released: boolean;
  }>;

export interface HushhSessionPrivacyPlugin {
  addListener(
    eventName: "privacyStateChanged",
    listener: (event: NativeSessionPrivacyEvent) => void,
  ): Promise<PluginListenerHandle>;
  getState(options: { documentId: string }): Promise<NativeSessionPrivacyState>;
  completeSessionValidation(options: {
    generation: number;
    documentId: string;
  }): Promise<NativeSessionPrivacyCompletion>;
}

const HushhSessionPrivacy = registerPlugin<HushhSessionPrivacyPlugin>(
  "HushhSessionPrivacy",
);

// Process-local metadata only. A reload creates a new JS runtime and ID; a
// remounted AuthProvider in the old document must not satisfy Restart session.
let documentId: string | undefined;
function privacyDocumentId(): string {
  return documentId ??= crypto.randomUUID();
}
// Share non-secret document metadata without changing the privacy acknowledgement entrypoints.
export { privacyDocumentId as nativeDocumentId };

const WEB_STATE: NativeSessionPrivacyState = Object.freeze({
  shielded: false,
  generation: 0,
  cause: "inactive",
  appIsActive: true,
});

// Nonsecret admission metadata, not session validation or credential state.
let observedPrivacy: NativeSessionPrivacyState | undefined;
let lifecycleEpoch = 0;
const observationListeners = new Set<() => void>();
export function subscribeNativePrivacyObservation(listener: () => void) {
  observationListeners.add(listener);
  return () => { observationListeners.delete(listener); };
}
function samePrivacyState(left: NativeSessionPrivacyState | undefined, right: NativeSessionPrivacyState) {
  return left?.generation === right.generation && left.shielded === right.shielded &&
    left.appIsActive === right.appIsActive && left.cause === right.cause;
}
function observePrivacy(state: NativeSessionPrivacyState) {
  const changed = !samePrivacyState(observedPrivacy, state);
  observedPrivacy = state;
  if (changed) observationListeners.forEach(listener => listener());
}
export function nativePrivacyObservation() {
  return { state: observedPrivacy, epoch: lifecycleEpoch };
}

function checkedState<T extends NativeSessionPrivacyState>(state: T): T {
  if (
    typeof state?.shielded !== "boolean" ||
    !Number.isSafeInteger(state.generation) || state.generation < 0 ||
    (state.shielded && state.generation === 0) ||
    !["inactive", "background", "restart"].includes(state.cause) ||
    typeof state.appIsActive !== "boolean"
  ) {
    throw new Error("Native session privacy state is unavailable.");
  }
  return state;
}

export async function subscribeNativeSessionPrivacy(
  listener: (event: NativeSessionPrivacyEvent) => void,
): Promise<PluginListenerHandle> {
  if (!Capacitor.isNativePlatform()) return { remove: async () => undefined };
  return HushhSessionPrivacy.addListener("privacyStateChanged", (event) => {
    try {
      const state = checkedState(event);
      // Each feature owns a Capacitor listener, but duplicate delivery of the
      // same lifecycle state is not a new boundary. Otherwise it can invalidate
      // the only in-flight release receipt and leave consumers covered forever.
      if (!samePrivacyState(observedPrivacy, state)) lifecycleEpoch += 1;
      observePrivacy(state);
      listener(state);
    } catch { /* getState catch-up owns recovery */ }
  });
}

/**
 * Read the generation that must be acknowledged to release the native privacy
 * cover. A cover exists only after this process has crossed an inactive
 * boundary; reading it does not perform an auth or account check.
 */
export async function getNativeSessionPrivacyState(): Promise<NativeSessionPrivacyState> {
  if (!Capacitor.isNativePlatform()) return WEB_STATE;
  const epoch = lifecycleEpoch;
  const state = checkedState(await HushhSessionPrivacy.getState({ documentId: privacyDocumentId() }));
  // Fence the returned value too: a consumer must not admit an old active
  // state after a newer inactive event merely because observation was fenced.
  if (epoch !== lifecycleEpoch && observedPrivacy) return observedPrivacy;
  observePrivacy(state);
  return state;
}

/**
 * Release only the exact lifecycle generation that the resumed document has
 * rendered. Native code rejects stale acknowledgements and acknowledgements
 * delivered while the app has backgrounded again.
 */
export async function completeNativeSessionPrivacyValidation(
  generation: number,
): Promise<NativeSessionPrivacyCompletion> {
  if (!Capacitor.isNativePlatform()) {
    return { ...WEB_STATE, released: false };
  }
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    return { ...WEB_STATE, released: false };
  }
  const epoch = lifecycleEpoch;
  const result = checkedState(await HushhSessionPrivacy.completeSessionValidation({
    generation, documentId: privacyDocumentId(),
  }));
  if (typeof result.released !== "boolean") {
    throw new Error("Native session privacy completion is unavailable.");
  }
  // Both native hosts return the release state without requiring a listener
  // event. Observe that authoritative result, but never replace a newer cycle.
  // Advancing the epoch also fences reads started before this completion.
  if (epoch === lifecycleEpoch) {
    lifecycleEpoch += 1;
    observePrivacy(result);
  }
  return result;
}
