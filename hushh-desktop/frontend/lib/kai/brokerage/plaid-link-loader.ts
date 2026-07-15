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

  plaidScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-plaid-link="true"]');
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.Plaid) resolve(window.Plaid);
      });
      existing.addEventListener("error", () => reject(new Error("Failed to load Plaid Link.")));
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.async = true;
    script.defer = true;
    script.dataset.plaidLink = "true";
    script.onload = () => {
      if (window.Plaid) {
        resolve(window.Plaid);
        return;
      }
      reject(new Error("Plaid Link loaded but window.Plaid was unavailable."));
    };
    script.onerror = () => {
      reject(new Error("Failed to load Plaid Link."));
    };
    document.head.appendChild(script);
  });

  return plaidScriptPromise;
}
