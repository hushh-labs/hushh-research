"use client";

import { useNativeTestBeacon } from "@/lib/testing/native-test";

export type NativeTestAuthState =
  | "public"
  | "authenticated"
  | "anonymous"
  | "redirecting"
  | "pending";

export type NativeTestDataState =
  | "booting"
  | "loading"
  | "loaded"
  | "empty-valid"
  | "unavailable-valid"
  | "redirect-valid"
  | "error";

// 1. Exported the Props type for better reusability
export type NativeTestBeaconProps = {
  routeId: string;
  marker: string;
  authState: NativeTestAuthState;
  dataState: NativeTestDataState;
  errorCode?: string | null;
  errorMessage?: string | null;
  attachToBridge?: ((bridge: NonNullable<Window["__HUSHH_NATIVE_TEST__"]>) => void) | null;
};

export function NativeTestBeacon({
  routeId,
  marker,
  authState,
  dataState,
  errorCode,
  errorMessage,
  attachToBridge,
}: NativeTestBeaconProps) {
  useNativeTestBeacon({
    routeId,
    marker,
    authState,
    dataState,
    errorCode,
    errorMessage,
    attachToBridge,
  });

  return (
    <div
      className="hidden" // 2. Replaced inline style with Tailwind utility class
      aria-hidden="true"
      data-testid={marker}
      data-native-test-beacon="true"
      data-native-route-id={routeId}
      data-native-auth-state={authState}
      data-native-data-state={dataState}
      data-native-error-code={errorCode || undefined} // 3. Fallback to undefined instead of ""
      data-native-error-message={errorMessage || undefined}
    />
  );
}