import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type NativeSessionPrivacyState = Readonly<{
  shielded: boolean;
  generation: number;
  cause: "inactive" | "background" | "restart";
  appIsActive: boolean;
  /** Capability and preparation metadata never change raw interaction privacy. */
  profilePreparation?: boolean;
  preparationAuthorized?: boolean;
  preparationRevision?: number;
  preparationVisitId?: string;
  preparationFormScene?: string | null;
  preparationBody?: "drawer" | "pane";
  profileMenuConcealed?: boolean;
  profilePreparationId?: string;
  presentationsRetiring?: boolean;
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
  prepareSessionValidation?(options: {
    generation: number; documentId: string; sessionRevision: number; profile: boolean;
    compositionRevision: number; visitId?: string; formScene?: string | null; body?: "drawer" | "pane";
  }): Promise<NativeSessionPrivacyState>;
  completeSessionValidation(options: {
    generation: number;
    documentId: string;
    sessionRevision?: number;
    compositionRevision?: number;
    preparationId?: string;
  }): Promise<NativeSessionPrivacyCompletion>;
}

// Registered on first use, not at import: the navigation shell imports this
// module, and importing it must not touch the native bridge.
let sessionPrivacyPlugin: HushhSessionPrivacyPlugin | undefined;
function sessionPrivacy(): HushhSessionPrivacyPlugin {
  return (sessionPrivacyPlugin ??= registerPlugin<HushhSessionPrivacyPlugin>(
    "HushhSessionPrivacy",
  ));
}

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
let observationRevision = 0;
const observationListeners = new Set<() => void>();
let expectedProfile: { token: symbol; owner: string; required: boolean; visitId: string; formScene: string | null; body: "drawer" | "pane" } | null = null;
let profileExpectationRevision = 0;
let sessionPreparationRevision = 0;
let sessionPreparationKey = "";
/** Includes safe-gate decisions and survives AuthProvider remounts in the
 * same document. Exact retries retain their revision; older decisions cannot
 * overwrite a newer authorization in native code. */
export function nativeSessionPreparationRevision(generation: number, session: number, composition: number, safeGate: boolean) {
  const key = JSON.stringify([generation, session, composition, safeGate]);
  if (sessionPreparationKey !== key) { sessionPreparationKey = key; sessionPreparationRevision++; }
  return sessionPreparationRevision;
}
const profileExpectationListeners = new Set<() => void>();
function profileExpectationChanged() { profileExpectationRevision++; profileExpectationListeners.forEach(listener => listener()); }
export function nativeProfilePreparationRevision() { return profileExpectationRevision; }
export function subscribeNativeProfilePreparation(listener: () => void) {
  profileExpectationListeners.add(listener);
  return () => { profileExpectationListeners.delete(listener); };
}
/** One authored Profile composition, not a registry of guessed DOM controls. */
export function expectNativeProfilePreparation(owner: string, required: boolean, visitId: string, formScene: string | null, body: "drawer" | "pane" = "drawer"): () => void {
  const token = Symbol("profile-composition");
  expectedProfile = { token, owner, required, visitId, formScene, body };
  profileExpectationChanged();
  return () => { if (expectedProfile?.token === token) { expectedProfile = null; profileExpectationChanged(); } };
}
export function nativeProfilePreparationExpected(owner: string | null | undefined): { visitId: string; formScene: string | null; body: "drawer" | "pane" } | null {
  return owner && expectedProfile?.owner === owner && expectedProfile.required
    ? { visitId: expectedProfile.visitId, formScene: expectedProfile.formScene, body: expectedProfile.body } : null;
}
export function nativePrivacyCanInteract(state = observedPrivacy): boolean {
  return !!state?.appIsActive && !state.shielded;
}
export function nativePrivacyCanPrepareProfile(state = observedPrivacy): boolean {
  return !!state?.appIsActive && (!state.shielded || state.preparationAuthorized === true && state.presentationsRetiring !== true);
}
export function subscribeNativePrivacyObservation(listener: () => void) {
  observationListeners.add(listener);
  return () => { observationListeners.delete(listener); };
}
function samePrivacyState(left: NativeSessionPrivacyState | undefined, right: NativeSessionPrivacyState) {
  return left?.generation === right.generation && left.shielded === right.shielded &&
    left.appIsActive === right.appIsActive && left.cause === right.cause;
}
function observePrivacy(state: NativeSessionPrivacyState) {
  const changed = !samePrivacyState(observedPrivacy, state) ||
    observedPrivacy?.preparationAuthorized !== state.preparationAuthorized ||
    observedPrivacy?.profilePreparationId !== state.profilePreparationId ||
    observedPrivacy?.preparationRevision !== state.preparationRevision ||
    observedPrivacy?.profileMenuConcealed !== state.profileMenuConcealed ||
    observedPrivacy?.presentationsRetiring !== state.presentationsRetiring;
  observedPrivacy = state;
  if (changed) { observationRevision++; observationListeners.forEach(listener => listener()); }
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
    || state.profilePreparation !== undefined && typeof state.profilePreparation !== "boolean"
    || state.preparationAuthorized !== undefined && typeof state.preparationAuthorized !== "boolean"
    || state.presentationsRetiring !== undefined && typeof state.presentationsRetiring !== "boolean"
    || state.profileMenuConcealed !== undefined && typeof state.profileMenuConcealed !== "boolean"
    || state.preparationBody !== undefined && !["drawer", "pane"].includes(state.preparationBody)
    || state.profilePreparationId !== undefined && (typeof state.profilePreparationId !== "string" ||
      state.profilePreparationId.length === 0 || state.profilePreparationId.length > 128)
    || state.preparationRevision !== undefined && (!Number.isSafeInteger(state.preparationRevision) || state.preparationRevision < 0)
    || state.preparationVisitId !== undefined && (typeof state.preparationVisitId !== "string" || !state.preparationVisitId || state.preparationVisitId.length > 128)
    || state.preparationFormScene !== undefined && state.preparationFormScene !== null && typeof state.preparationFormScene !== "string"
  ) {
    throw new Error("Native session privacy state is unavailable.");
  }
  return state;
}

export async function subscribeNativeSessionPrivacy(
  listener: (event: NativeSessionPrivacyEvent) => void,
): Promise<PluginListenerHandle> {
  if (!Capacitor.isNativePlatform()) return { remove: async () => undefined };
  return sessionPrivacy().addListener("privacyStateChanged", (event) => {
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
  const epoch = observationRevision;
  const state = checkedState(await sessionPrivacy().getState({ documentId: privacyDocumentId() }));
  // Fence the returned value too: a consumer must not admit an old active
  // state after a newer inactive event merely because observation was fenced.
  if (epoch !== observationRevision && observedPrivacy) return observedPrivacy;
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
  sessionRevision?: number,
  compositionRevision?: number,
): Promise<NativeSessionPrivacyCompletion> {
  if (!Capacitor.isNativePlatform()) {
    return { ...WEB_STATE, released: false };
  }
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    return { ...WEB_STATE, released: false };
  }
  const epoch = observationRevision;
  const result = checkedState(await sessionPrivacy().completeSessionValidation({
    generation, documentId: privacyDocumentId(),
    ...(observedPrivacy?.generation === generation && observedPrivacy.preparationAuthorized === true ? {
      sessionRevision, compositionRevision, ...(observedPrivacy.profilePreparationId ? { preparationId: observedPrivacy.profilePreparationId } : {}),
    } : {}),
  }));
  if (typeof result.released !== "boolean") {
    throw new Error("Native session privacy completion is unavailable.");
  }
  // Both native hosts return the release state without requiring a listener
  // event. Observe that authoritative result, but never replace a newer cycle.
  // Advancing the epoch also fences reads started before this completion.
  if (epoch === observationRevision) {
    lifecycleEpoch += 1;
    observePrivacy(result);
  }
  return result;
}

/** Auth calls this only after committing its validated destination or safe gate.
 * Older wrappers keep their established release transaction. */
export async function prepareNativeSessionPrivacyValidation(generation: number, sessionRevision: number,
  profile: { visitId: string; formScene: string | null; body?: "drawer" | "pane" } | null, compositionRevision: number) {
  const current = observedPrivacy;
  if (!Capacitor.isNativePlatform() || current?.profilePreparation !== true) return;
  if (current.presentationsRetiring) throw new Error("Native presentations are retiring.");
  const plugin = sessionPrivacy();
  if (!plugin.prepareSessionValidation || !Number.isSafeInteger(sessionRevision) || sessionRevision < 0) {
    throw new Error("Native composition preparation is unavailable.");
  }
  const epoch = observationRevision;
  const result = checkedState(await plugin.prepareSessionValidation({
    generation, documentId: privacyDocumentId(), sessionRevision, profile: profile !== null, compositionRevision,
    ...(profile ?? {}),
  }));
  if (epoch === observationRevision && result.generation === generation) observePrivacy(result);
}
