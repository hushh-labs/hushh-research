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
      bootstrapState?: string;
      bootstrapUserId?: string;
      bootstrapError?: string;
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

    if (sync()) {
      return;
    }

    const timer = window.setInterval(() => {
      if (sync()) {
        window.clearInterval(timer);
      }
    }, 250);

    return () => {
      window.clearInterval(timer);
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
