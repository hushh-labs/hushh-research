import { Capacitor, registerPlugin } from "@capacitor/core";

export type NativeSessionPrivacyState = Readonly<{
  shielded: boolean;
  generation: number;
}>;

export type NativeSessionPrivacyCompletion = NativeSessionPrivacyState &
  Readonly<{
    released: boolean;
  }>;

export interface HushhSessionPrivacyPlugin {
  getState(): Promise<NativeSessionPrivacyState>;
  completeSessionValidation(options: {
    generation: number;
  }): Promise<NativeSessionPrivacyCompletion>;
}

const HushhSessionPrivacy = registerPlugin<HushhSessionPrivacyPlugin>(
  "HushhSessionPrivacy",
);

const WEB_STATE: NativeSessionPrivacyState = Object.freeze({
  shielded: false,
  generation: 0,
});

/**
 * Capture this generation before starting foreground auth validation. A native
 * cover exists only after this process has crossed an inactive boundary.
 */
export async function getNativeSessionPrivacyState(): Promise<NativeSessionPrivacyState> {
  if (!Capacitor.isNativePlatform()) return WEB_STATE;
  return HushhSessionPrivacy.getState();
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
  return HushhSessionPrivacy.completeSessionValidation({ generation });
}
