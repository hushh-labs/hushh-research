"use client";

import {
  getGoogleIdentityServices,
  preloadGoogleIdentityServices,
} from "@/lib/contacts/google-contacts-token";

import { isHostedWebOAuthOrigin } from "./hosted-web-oauth-origins";

export { HOSTED_WEB_OAUTH_ORIGINS, isHostedWebOAuthOrigin, UAT_MAIL_ORIGIN } from "./hosted-web-oauth-origins";

const CONNECTOR_DIALOG_HEADINGS: Record<string, string> = {
  gmail: "Connect Gmail",
  calendar: "Connect Google Calendar",
  drive: "Connect Google Drive",
};

type CodeClientOptions = {
  client_id: string;
  scope: string;
  ux_mode: "popup";
  select_account: boolean;
  include_granted_scopes: boolean;
  callback: (response: { code?: string; error?: string }) => void;
  error_callback: (error?: { type?: string }) => void;
};

/**
 * Open Google's sign-in straight from the click that started the connection, with
 * no confirmation first. Only when the browser refuses that window (it no longer
 * counts the click as recent) does the owner see one "Continue with Google" button,
 * whose own click is the fresh gesture the browser wants.
 */
export async function requestHostedBrowserGoogleCode(
  clientId: string,
  scopes: string[],
  current: () => boolean,
  connector = "gmail",
): Promise<string> {
  await preloadGoogleIdentityServices();
  const oauth = getGoogleIdentityServices()?.accounts?.oauth2 as
    | { initCodeClient?: (options: CodeClientOptions) => { requestCode(): void } }
    | undefined;
  if (!isHostedWebOAuthOrigin(location.origin) || !oauth?.initCodeClient || !current()) {
    throw new Error("SIGN_IN_INCOMPLETE");
  }
  const init = oauth.initCodeClient.bind(oauth);
  const titleText = CONNECTOR_DIALOG_HEADINGS[connector] ?? "Connect Google";
  return new Promise((resolve, reject) => {
    let dialog: HTMLDialogElement | undefined;
    let settled = false;
    function finish(code?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(sessionCheck);
      dialog?.remove();
      if (code && current()) resolve(code);
      else reject(new Error("SIGN_IN_CANCELLED"));
    }
    const timeout = setTimeout(() => finish(), 5 * 60_000);
    const sessionCheck = setInterval(() => {
      if (!current()) finish();
    }, 500);
    // `blocked` runs only when the browser would not open the window.
    function open(blocked?: () => void) {
      try {
        init({
          client_id: clientId,
          scope: scopes.join(" "),
          ux_mode: "popup",
          select_account: true,
          include_granted_scopes: false,
          callback: (result) => finish(result.error ? undefined : result.code),
          error_callback: (error) => (blocked && error?.type === "popup_failed_to_open" ? blocked() : finish()),
        }).requestCode();
      } catch {
        if (blocked) blocked();
        else finish();
      }
    }
    function askToContinue() {
      if (settled) return;
      const box = document.createElement("dialog");
      dialog = box;
      const heading = document.createElement("h2");
      heading.textContent = titleText;
      box.setAttribute("aria-label", titleText);
      box.className = "m-auto rounded-2xl bg-background p-6 text-foreground shadow-xl backdrop:bg-black/40";
      const allow = document.createElement("button");
      allow.textContent = "Continue with Google";
      allow.className = "mt-4 rounded-full bg-primary px-4 py-2 text-primary-foreground";
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.className = "ml-3 px-3 py-2";
      cancel.onclick = () => finish();
      box.oncancel = () => finish();
      allow.onclick = () => {
        if (!current()) return finish();
        allow.disabled = true;
        open();
      };
      box.append(heading, allow, cancel);
      document.body.append(box);
      try {
        box.showModal();
      } catch {
        finish();
      }
    }
    open(askToContinue);
  });
}

export const requestMailBrowserCode = requestHostedBrowserGoogleCode;
