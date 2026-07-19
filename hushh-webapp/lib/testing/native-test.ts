"use client";

import { useEffect, useState } from "react";

declare global {
  interface Window {
    __HUSHH_NATIVE_TEST__?: {
      enabled?: boolean;
      autoReviewerLogin?: boolean;
      vaultPassphrase?: string;
      expectedUserId?: string;
      expectedMarker?: string;
      initialRoute?: string;
      expectedRoute?: string;
      uiFlowRunId?: string;
      beacon?: {
        routeId: string;
        marker: string;
        authState: string;
        dataState: string;
        errorCode: string;
        errorMessage: string;
      };
      triggerReviewerLogin?: (() => void) | null;
      triggerVaultUnlock?: (() => void) | null;
      replayVaultUnlock?: (() => void) | null;
      switchPersona?: ((target: "investor" | "ria") => Promise<unknown>) | null;
      navigateToRoute?: ((route: string) => void) | null;
      bootstrapState?: string;
      bootstrapUserId?: string;
      bootstrapError?: string;
      bootstrapErrorClass?: string;
      vaultCryptoStage?: string;
      vaultCryptoErrorName?: string;
      vaultCryptoSubtleAvailable?: boolean;
      vaultCryptoPassphraseMatchesConfig?: boolean;
      vaultCryptoPassphraseUtf8Length?: number;
      vaultCryptoSaltLength?: number;
      vaultCryptoIvLength?: number;
      vaultCryptoCiphertextLength?: number;
      activePersona?: string;
      primaryNavPersona?: string;
      personaSwitchStatus?: string;
      personaSwitchError?: string;
      portfolioImportStartState?: string;
      portfolioImportStartStatus?: string;
      portfolioImportStartRunId?: string;
      portfolioImportStartError?: string;
      portfolioStreamState?: string;
      portfolioStreamRunId?: string;
      portfolioStreamEventCount?: number;
      portfolioStreamLastEvent?: string;
      portfolioStreamLastSeq?: string;
      portfolioStreamLastError?: string;
    };
  }
}

export type NativeTestConfig = {
  enabled: boolean;
  autoReviewerLogin: boolean;
  vaultPassphrase: string | null;
  expectedUserId: string | null;
  expectedMarker: string | null;
  initialRoute: string | null;
  expectedRoute: string | null;
};

function sanitizeConfiguredValue(value: string | null | undefined) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  if (/replace_with_/i.test(trimmed)) return null;
  if (/your_[a-z0-9_]+_here/i.test(trimmed)) return null;
  return trimmed;
}

function readNativeTestBridgeEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  // Require the injected bridge from -UITestMode launch args.
  // Do not treat DOM dataset hints alone as a test session.
  return window.__HUSHH_NATIVE_TEST__?.enabled === true;
}

export function getNativeUiTestVaultPassphrase(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (window.__HUSHH_NATIVE_TEST__?.enabled !== true) {
    return null;
  }
  const value = String(window.__HUSHH_NATIVE_TEST__?.vaultPassphrase || "").trim();
  return value || null;
}

/** Skip auto passkey/biometric prompts during native UITest or Playwright runs. */
export function shouldSkipGeneratedVaultUnlockForAutomation(
  config: NativeTestConfig = getNativeTestConfig()
): boolean {
  if (typeof navigator !== "undefined" && navigator.webdriver) {
    return true;
  }
  return isNativeUiTestSession(config) && Boolean(getNativeUiTestVaultPassphrase());
}

/**
 * True only during explicit native UI automation (XCUITest / Espresso launch args).
 * Normal production users never hit this path.
 */
export function isNativeUiTestSession(
  config: NativeTestConfig = getNativeTestConfig()
): boolean {
  return readNativeTestBridgeEnabled() && config.enabled;
}

/**
 * Prefer passphrase unlock over biometric/passkey only in automation contexts.
 * Never changes unlock behavior for real users in production or UAT manual use.
 */
export function preferPassphraseUnlockForAutomation(
  config: NativeTestConfig = getNativeTestConfig()
): boolean {
  return shouldSkipGeneratedVaultUnlockForAutomation(config);
}

/** Native UITest bootstrap owns auth + vault unlock; hide biometric dialog while it runs. */
export function isNativeTestVaultBootstrapManaged(
  config: NativeTestConfig = getNativeTestConfig()
): boolean {
  return (
    isNativeUiTestSession(config) &&
    config.autoReviewerLogin &&
    Boolean(config.expectedUserId) &&
    Boolean(config.vaultPassphrase)
  );
}

const NATIVE_UI_FLOW_STORAGE_KEY_PREFIX = "__hushh_native_ui_flow_state_v1";

function nativeUiFlowStorageKey(): string {
  const runId = String(
    window.__HUSHH_NATIVE_TEST__?.uiFlowRunId ?? "",
  ).replace(/[^a-zA-Z0-9_-]/g, "");
  return runId
    ? `${NATIVE_UI_FLOW_STORAGE_KEY_PREFIX}:${runId}`
    : NATIVE_UI_FLOW_STORAGE_KEY_PREFIX;
}

/**
 * A native UI flow can cross a full WebView document boundary before the
 * platform bridge has re-injected its config. The runner persists this narrow
 * resume marker so auth guards can hold the requested route during that gap.
 */
export function hasIncompleteNativeUiFlowSession(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const raw = window.sessionStorage.getItem(nativeUiFlowStorageKey());
    if (!raw) return false;
    const state = JSON.parse(raw) as {
      started?: unknown;
      complete?: unknown;
      nextIndex?: unknown;
      report?: { startedAt?: unknown } | null;
    };
    return (
      state.started === true &&
      state.complete === false &&
      Number.isInteger(state.nextIndex) &&
      Number(state.nextIndex) >= 0 &&
      typeof state.report?.startedAt === "string"
    );
  } catch {
    return false;
  }
}

export function getNativeTestConfig(): NativeTestConfig {
  if (typeof window === "undefined") {
    return {
      enabled: false,
      autoReviewerLogin: false,
      vaultPassphrase: null,
      expectedUserId: null,
      expectedMarker: null,
      initialRoute: null,
      expectedRoute: null,
    };
  }

  const raw = window.__HUSHH_NATIVE_TEST__ ?? {};
  const root = document.documentElement;
  const enabledFromDataset =
    root.getAttribute("data-hushh-native-test-enabled") === "true";
  const autoReviewerLoginFromDataset =
    root.getAttribute("data-hushh-native-test-auto-reviewer-login") === "true";
  const expectedMarkerFromDataset =
    root.getAttribute("data-hushh-native-test-expected-marker");
  const initialRouteFromDataset =
    root.getAttribute("data-hushh-native-test-initial-route");
  const expectedRouteFromDataset =
    root.getAttribute("data-hushh-native-test-expected-route");
  return {
    enabled: raw.enabled === true || enabledFromDataset,
    autoReviewerLogin:
      raw.autoReviewerLogin === true || autoReviewerLoginFromDataset,
    vaultPassphrase:
      typeof raw.vaultPassphrase === "string" && raw.vaultPassphrase.trim().length > 0
        ? raw.vaultPassphrase
        : null,
    expectedUserId: sanitizeConfiguredValue(raw.expectedUserId),
    expectedMarker:
      typeof raw.expectedMarker === "string" && raw.expectedMarker.trim().length > 0
        ? raw.expectedMarker.trim()
        : typeof expectedMarkerFromDataset === "string" &&
            expectedMarkerFromDataset.trim().length > 0
          ? expectedMarkerFromDataset.trim()
        : null,
    initialRoute:
      typeof raw.initialRoute === "string" && raw.initialRoute.trim().length > 0
        ? raw.initialRoute.trim()
        : typeof initialRouteFromDataset === "string" &&
            initialRouteFromDataset.trim().length > 0
          ? initialRouteFromDataset.trim()
        : null,
    expectedRoute:
      typeof raw.expectedRoute === "string" && raw.expectedRoute.trim().length > 0
        ? raw.expectedRoute.trim()
        : typeof expectedRouteFromDataset === "string" &&
            expectedRouteFromDataset.trim().length > 0
          ? expectedRouteFromDataset.trim()
        : null,
  };
}

export function useNativeTestConfig(): NativeTestConfig {
  const [config, setConfig] = useState<NativeTestConfig>(() => getNativeTestConfig());

  useEffect(() => {
    let attempts = 0;
    let timer: number | null = null;
    const sync = () => {
      const nextConfig = getNativeTestConfig();
      setConfig(nextConfig);
      attempts += 1;
      if (
        nextConfig.enabled ||
        nextConfig.autoReviewerLogin ||
        attempts >= 20
      ) {
        return true;
      }
      return false;
    };

    const handleConfigUpdate = () => {
      sync();
    };

    window.addEventListener("hushh:native-test-config-updated", handleConfigUpdate);

    // The native bridge is injected incrementally. Keep the update listener even
    // when the first snapshot already says `enabled`; passphrase/expected-user
    // fields may arrive in a later bridge update and must reach React state.
    if (!sync()) {
      timer = window.setInterval(() => {
        if (sync()) {
          if (timer) {
            window.clearInterval(timer);
            timer = null;
          }
        }
      }, 250);
    }

    return () => {
      if (timer) {
        window.clearInterval(timer);
      }
      window.removeEventListener("hushh:native-test-config-updated", handleConfigUpdate);
    };
  }, []);

  return config;
}

type NativeTestBeaconPayload = {
  routeId: string;
  marker: string;
  authState: string;
  dataState: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  attachToBridge?: ((bridge: NonNullable<Window["__HUSHH_NATIVE_TEST__"]>) => void) | null;
};

export function useNativeTestBeacon(payload: NativeTestBeaconPayload) {
  const {
    attachToBridge,
    authState,
    dataState,
    errorCode,
    errorMessage,
    marker,
    routeId,
  } = payload;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const bridge = window.__HUSHH_NATIVE_TEST__;
    if (!bridge?.enabled) {
      return;
    }

    if (attachToBridge) {
      attachToBridge(bridge);
    }

    bridge.beacon = {
      routeId,
      marker,
      authState,
      dataState,
      errorCode: errorCode ?? "",
      errorMessage: errorMessage ?? "",
    };

    return () => {
      if (window.__HUSHH_NATIVE_TEST__?.beacon?.marker === marker) {
        delete window.__HUSHH_NATIVE_TEST__.beacon;
      }
    };
  }, [
    attachToBridge,
    authState,
    dataState,
    errorCode,
    errorMessage,
    marker,
    routeId,
  ]);
}
