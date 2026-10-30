"use client";

import { HushhPlaidLink, isNativePlaidLinkAvailable } from "@/lib/capacitor/plaid-link";
import { markNativePlaidLinkOpened } from "@/lib/kai/brokerage/native-plaid-session";

declare global {
  interface Window {
    Plaid?: {
      create: (config: Record<string, unknown>) => {
        open: () => void;
        exit: (options?: Record<string, unknown>, callback?: () => void) => void;
        destroy?: () => void;
      };
    };
  }
}

type PlaidLinkStatic = NonNullable<Window["Plaid"]>;
type PlaidLinkConfig = {
  token?: string;
  /** Web only: resumes a bank's OAuth login on the redirect page. */
  receivedRedirectUri?: string;
  onSuccess?: (publicToken: string, metadata: Record<string, unknown>) => void;
  onExit?: (error: Record<string, unknown> | null, metadata?: Record<string, unknown>) => void;
  onEvent?: (eventName: string, metadata: Record<string, unknown>) => void;
};

let plaidScriptPromise: Promise<PlaidLinkStatic> | null = null;
let nativePlaidLink: PlaidLinkStatic | null = null;
const PLAID_LINK_LOAD_TIMEOUT_MS = 15_000;

/**
 * On the native shell, Plaid's own SDK (LinkKit on iOS, the Link SDK on
 * Android) behind the same `create(config).open()` shape the page already
 * uses, so a bank's OAuth leg and its return into the app are the SDK's, not
 * the WebView's. Where the native plugin is absent or reports the device
 * unsupported, the web SDK loads as before.
 */
function createNativePlaidLink(): PlaidLinkStatic {
  return {
    create: (rawConfig: Record<string, unknown>) => {
      const config = rawConfig as PlaidLinkConfig;
      let eventHandle: { remove: () => Promise<void> } | null = null;
      let opened = false;
      const detach = () => {
        void eventHandle?.remove();
        eventHandle = null;
      };
      return {
        open: () => {
          if (opened) return;
          opened = true;
          const token = String(config.token ?? "");
          const markClosed = markNativePlaidLinkOpened();
          void (async () => {
            if (config.onEvent) {
              eventHandle = await HushhPlaidLink.addListener("plaidLinkEvent", (event) => {
                config.onEvent?.(event.eventName, event.metadata);
              }).catch(() => null);
            }
            try {
              const result = await HushhPlaidLink.open({ token });
              markClosed();
              detach();
              if (result.exit) {
                config.onExit?.(result.error ? { ...result.error } : null, result.metadata);
              } else {
                config.onSuccess?.(result.publicToken, result.metadata);
              }
            } catch (error) {
              markClosed();
              detach();
              config.onExit?.(
                { code: "NATIVE_LINK_FAILED", message: error instanceof Error ? error.message : String(error) },
                {},
              );
            }
          })();
        },
        exit: (_options?: Record<string, unknown>, callback?: () => void) => {
          callback?.();
        },
        destroy: () => {
          detach();
        },
      };
    },
  };
}

export async function loadPlaidLink(): Promise<PlaidLinkStatic> {
  if (typeof window === "undefined") {
    throw new Error("Plaid Link is only available in the browser.");
  }
  if (await isNativePlaidLinkAvailable()) {
    nativePlaidLink ??= createNativePlaidLink();
    return nativePlaidLink;
  }
  if (window.Plaid) {
    return window.Plaid;
  }
  if (plaidScriptPromise) {
    return plaidScriptPromise;
  }

  const loadPromise = new Promise<PlaidLinkStatic>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-plaid-link="true"]');
    const script = existing ?? document.createElement("script");
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    };
    const fail = (error: Error) => {
      cleanup();
      if (!window.Plaid) script.remove();
      reject(error);
    };
    const handleLoad = () => {
      if (window.Plaid) {
        cleanup();
        resolve(window.Plaid);
        return;
      }
      fail(new Error("Plaid Link loaded but window.Plaid was unavailable."));
    };
    const handleError = () => {
      fail(new Error("Failed to load Plaid Link."));
    };
    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
    timeoutHandle = setTimeout(
      () => fail(new Error("Plaid Link did not load in time.")),
      PLAID_LINK_LOAD_TIMEOUT_MS,
    );
    if (!existing) {
      script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
      script.async = true;
      script.defer = true;
      script.dataset.plaidLink = "true";
      document.head.appendChild(script);
    }
  });

  plaidScriptPromise = loadPromise.catch((error) => {
    plaidScriptPromise = null;
    throw error;
  });

  return plaidScriptPromise;
}
