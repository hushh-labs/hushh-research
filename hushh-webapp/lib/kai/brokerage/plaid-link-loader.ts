"use client";

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

let plaidScriptPromise: Promise<NonNullable<Window["Plaid"]>> | null = null;
const PLAID_LINK_LOAD_TIMEOUT_MS = 15_000;

export async function loadPlaidLink(): Promise<NonNullable<Window["Plaid"]>> {
  if (typeof window === "undefined") {
    throw new Error("Plaid Link is only available in the browser.");
  }
  if (window.Plaid) {
    return window.Plaid;
  }
  if (plaidScriptPromise) {
    return plaidScriptPromise;
  }

  const loadPromise = new Promise<NonNullable<Window["Plaid"]>>((resolve, reject) => {
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
