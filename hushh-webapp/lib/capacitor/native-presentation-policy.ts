import { interfacePresentationSnapshot } from "./native-interface-revision";

type RendererBootstrap = {
  contractVersion: number;
  documentId?: string;
  enabled: boolean;
  coherentShell?: boolean;
  ownedChoices?: boolean;
  nativeInterfacePreference?: boolean;
  liveInterfaceSwitch?: boolean;
};

function bootstrap(): RendererBootstrap | undefined {
  if (typeof window === "undefined") return;
  return (window as Window & { __HUSHH_NATIVE_DRAWER_BOOTSTRAP__?: RendererBootstrap })
    .__HUSHH_NATIVE_DRAWER_BOOTSTRAP__;
}

let appliedMode: boolean | undefined;
export function customNativePresentationEnabled(): boolean {
  const boot = bootstrap();
  return interfacePresentationSnapshot() >= 0 && boot?.contractVersion === 1 && (appliedMode ?? (boot.enabled && boot.coherentShell === true));
}

export function nativeInterfacePreferenceAvailable(): boolean {
  const boot = bootstrap();
  return boot?.contractVersion === 1 && boot.nativeInterfacePreference === true;
}

export function liveInterfaceSwitchAvailable(): boolean {
  return nativeInterfacePreferenceAvailable() && bootstrap()?.liveInterfaceSwitch === true;
}

export function nativeOwnedChoicesEnabled(): boolean {
  return customNativePresentationEnabled() && (bootstrap()?.ownedChoices === true || liveInterfaceSwitchAvailable());
}

/** Only a host receipt for the current WebView can change the applied mode. */
export function acknowledgeNativeInterface(documentId: string, enabled: boolean) {
  if (!liveInterfaceSwitchAvailable() || bootstrap()?.documentId !== documentId) throw new Error("Interface document changed");
  appliedMode = enabled;
}
