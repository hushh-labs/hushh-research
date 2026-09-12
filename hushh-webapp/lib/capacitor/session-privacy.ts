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

const WEB_STATE: NativeSessionPrivacyState = Object.freeze({
  shielded: false,
  generation: 0,
  cause: "inactive",
  appIsActive: true,
});

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
    try { listener(checkedState(event)); } catch { /* getState catch-up owns recovery */ }
  });
}

/**
 * Capture this generation before starting foreground auth validation. A native
 * cover exists only after this process has crossed an inactive boundary.
 */
export async function getNativeSessionPrivacyState(): Promise<NativeSessionPrivacyState> {
  if (!Capacitor.isNativePlatform()) return WEB_STATE;
  return checkedState(await HushhSessionPrivacy.getState({ documentId: privacyDocumentId() }));
}

/**
 * Release only the exact lifecycle generation that the caller has finished
 * validating. Native code rejects stale acknowledgements and acknowledgements
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
  const result = checkedState(await HushhSessionPrivacy.completeSessionValidation({
    generation, documentId: privacyDocumentId(),
  }));
  if (typeof result.released !== "boolean") {
    throw new Error("Native session privacy completion is unavailable.");
  }
  return result;
}
